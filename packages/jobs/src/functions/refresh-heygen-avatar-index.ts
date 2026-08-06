/**
 * Polish-26 Commit 61: refresh of the enriched HeyGen avatar index.
 *
 * Direct mirror of refresh-makeugc-avatar-index.ts (see that file's
 * header for the WHY on the two-single-trigger-function pattern).
 * Two Inngest functions delegate to a shared core:
 *
 *   refreshHeygenAvatarIndexCron   — id: 'refresh-heygen-avatar-index-cron'
 *                                     trigger: { cron: '0 4 * * *' }  (1h after MakeUGC)
 *                                     userId from HEYGEN_REFRESH_USER_ID env
 *   refreshHeygenAvatarIndexManual — id: 'refresh-heygen-avatar-index'
 *                                     trigger: { event: 'heygen/avatar-index.refresh.requested' }
 *                                     userId + forceAll from event.data
 *
 * Steps in the core (each its own step.run):
 *   A. fetch-avatar-list        — GET /v2/avatars (full library).
 *   B. diff-against-index       — split new / stale (>7d) / unchanged / disappeared.
 *   C. mark-disappeared-deleted — soft-delete rows no longer on HeyGen.
 *   D. analyze-batch            — Gemini vision on new + stale thumbnails,
 *                                  concurrency-limited to 5. Reuses the
 *                                  MakeUGC vision prompt verbatim — the
 *                                  person-classification schema is provider-
 *                                  agnostic.
 *   E. persist-batch            — upsert enriched descriptors.
 *   F. touch-fresh-rows         — bump lastRefreshedAt.
 *   G. return summary.
 */
import { and, inArray, isNull } from 'drizzle-orm';
import { NonRetriableError, type GetStepTools } from 'inngest';
import {
  analyzeMakeugcAvatarThumbnail,
  listHeygenAvatars,
  type HeygenAvatarV3,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { resolveHeygenManagedKey } from '../lib/resolve-heygen-managed-key';
import { safeInngestStepReturn, stripUndefined, stripUndefinedDeep } from '../lib/strip-undefined';
import {
  assertArrayNoUndefinedForPostgres,
  assertNoUndefinedForPostgres,
  assertScalarDefinedForPostgres,
  guardedStepRun,
  rethrowWithUndefinedContext,
  safeErrorShape,
} from '../lib/assert-no-undefined-for-postgres';
import {
  MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT,
  parseMakeugcAvatarVisionAnalysisWithDiagnostics,
  type MakeugcAvatarVisionAnalysis,
} from '../lib/makeugc-avatar-vision-prompt';

console.log(`[jobs.refresh-heygen-avatar-index] cold start — POLISH_VERSION=${POLISH_VERSION}`);

const VISION_CONCURRENCY = 5;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Polish-26.0.4 Commit 61.4: chunk size for the analyze + persist
 * loop. Vercel Hobby caps each function invocation at 60 seconds.
 * At Gemini-vision ~2-5s per thumbnail × VISION_CONCURRENCY=5,
 * a chunk of 12 avatars runs in ~5-15s wall-clock — safely under
 * the 60s ceiling with plenty of margin for cold-start + DB
 * round-trips.
 *
 * Each chunk is its own step.run(), so Inngest schedules it as a
 * fresh 60s HTTP invocation. Total sync completes across MANY
 * invocations (1264 avatars ÷ 12 = ~106 chunks) but no single
 * invocation ever risks timeout. Bump this via env when moving to
 * Vercel Pro (300s ceiling) — 100 becomes comfortable.
 */
const DEFAULT_ANALYZE_CHUNK_SIZE = 12;

export function resolveHeygenAnalyzeChunkSize(): number {
  const raw = process.env['HEYGEN_ANALYZE_CHUNK_SIZE']?.trim();
  if (!raw) return DEFAULT_ANALYZE_CHUNK_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_ANALYZE_CHUNK_SIZE;
  return Math.floor(parsed);
}

/** Split `items` into chunks of at most `size`. Preserves order. */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunkArray size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Fingerprint the first 120 chars of an error message with digits
 * normalized so "Gemini 500 Internal (req 123)" and
 * "Gemini 500 Internal (req 456)" hash identically. Used by the
 * consecutive-same-signature circuit breaker.
 */
export function errorSignature(msg: string): string {
  return msg.slice(0, 120).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Polish-26.0.10 Commit 62: bumped 20 → 40 alongside the failure-
 * signature split. Two mitigations acting together:
 *
 *   1. parseMakeugcAvatarVisionAnalysisWithDiagnostics emits a
 *      per-drift-pattern signature (schema:ethnicity vs
 *      schema:background_setting vs mime-filter etc.) instead of
 *      collapsing all schema-fails to one constant "JSON did not
 *      match schema" string, so 20 different Gemini drifts no longer
 *      accumulate under one bucket.
 *   2. The coercion layer accepts common enum-drift equivalents
 *      (south_asian -> asian, grey -> gray, numeric age, etc.),
 *      cutting the RAW schema-fail rate before it reaches this
 *      counter.
 *
 * 40 gives enough headroom that a genuinely-repeating same-
 * signature streak (e.g. HeyGen re-serving broken images for one
 * shard) still short-circuits — but a mix of ordinary drift
 * patterns doesn't trip.
 */
const CROSS_CHUNK_CONSECUTIVE_FAILURE_THRESHOLD = 40;

/** How many distinct-signature failure samples to keep on the summary. */
const DISTINCT_FAILURE_SAMPLE_CAP = 5;

interface RefreshEventData {
  userId?: string;
  forceAll?: boolean;
}

export function resolveHeygenRefreshUserId(eventUserId: string | undefined): string {
  if (eventUserId && typeof eventUserId === 'string' && eventUserId.trim().length > 0) {
    return eventUserId.trim();
  }
  const envUserId = process.env['HEYGEN_REFRESH_USER_ID']?.trim();
  if (envUserId && envUserId.length > 0) {
    return envUserId;
  }
  throw new NonRetriableError(
    'refresh-heygen-avatar-index: no userId. Set HEYGEN_REFRESH_USER_ID env for cron ' +
      'path, or pass { userId } in the manual event payload.',
  );
}

interface HeygenDiffBuckets {
  toAnalyze: HeygenAvatarV3[];
  toTouchOnly: HeygenAvatarV3[];
  toSoftDelete: string[];
}

export function bucketizeHeygen(
  liveAvatars: readonly HeygenAvatarV3[],
  indexRows: readonly { avatarId: string; visionAnalyzedAt: Date; deletedAt: Date | null }[],
  now: number,
  forceAll: boolean,
): HeygenDiffBuckets {
  const indexById = new Map<string, { visionAnalyzedAt: Date; deletedAt: Date | null }>();
  for (const r of indexRows) {
    indexById.set(r.avatarId, { visionAnalyzedAt: r.visionAnalyzedAt, deletedAt: r.deletedAt });
  }
  const toAnalyze: HeygenAvatarV3[] = [];
  const toTouchOnly: HeygenAvatarV3[] = [];
  const liveIds = new Set<string>();

  for (const a of liveAvatars) {
    liveIds.add(a.avatar_id);
    const prior = indexById.get(a.avatar_id);
    if (!prior || prior.deletedAt !== null) {
      toAnalyze.push(a);
      continue;
    }
    if (forceAll) {
      toAnalyze.push(a);
      continue;
    }
    const age = now - prior.visionAnalyzedAt.getTime();
    if (age >= STALE_MS) {
      toAnalyze.push(a);
    } else {
      toTouchOnly.push(a);
    }
  }
  const toSoftDelete: string[] = [];
  for (const r of indexRows) {
    if (r.deletedAt !== null) continue;
    if (!liveIds.has(r.avatarId)) toSoftDelete.push(r.avatarId);
  }
  return { toAnalyze, toTouchOnly, toSoftDelete };
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; result: R } | { ok: false; error: string }>> {
  const out = new Array<{ ok: true; result: R } | { ok: false; error: string } | undefined>(
    items.length,
  );
  let cursor = 0;
  async function pump(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        const r = await worker(items[idx]!, idx);
        out[idx] = { ok: true, result: r };
      } catch (err) {
        out[idx] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pump()));
  return out as Array<{ ok: true; result: R } | { ok: false; error: string }>;
}

type StepTools = GetStepTools<typeof inngest>;

export interface HeygenRefreshCoreParams {
  step: StepTools;
  userId: string;
  forceAll: boolean;
  startedAt: number;
  trigger: 'cron' | 'manual';
}

export async function refreshHeygenAvatarIndexCore(
  params: HeygenRefreshCoreParams,
): Promise<Record<string, unknown>> {
  const { step, forceAll, startedAt, trigger } = params;
  // Polish-26.0.13 Commit 62.3: guard userId at entry. Every WHERE
  // clause in the sync worker + its dependencies (loadDecryptedKeys,
  // resolveHeygenManagedKey) binds userId; a bare-undefined
  // slip-through here trips postgres-js UNDEFINED_VALUE at the
  // first eq(column, userId) call, which is exactly the failure
  // class Commits 62.1 / 62.2 were misdiagnosed as (they patched
  // Inngest's UNDEFINED_VALUE, not postgres-js's).
  const userId = assertScalarDefinedForPostgres(
    params.userId,
    'params.userId',
    'refreshHeygenAvatarIndexCore:entry',
  );
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new NonRetriableError(
      `refresh-heygen-avatar-index: userId must be a non-empty string, got ` +
        `${JSON.stringify(userId)} (typeof ${typeof userId}).`,
    );
  }

  // Step A: fetch live library.
  const liveAvatars = await guardedStepRun(step, 'fetch-avatar-list', async () => {
    let heygenKey: string;
    try {
      const resolved = await resolveHeygenManagedKey({ userId });
      heygenKey = resolved.apiKey;
    } catch (err) {
      if (err instanceof MissingProviderKeyError) {
        throw new NonRetriableError(
          `refresh-heygen-avatar-index: no HeyGen key available ` +
            `(env HEYGEN_MANAGED_KEY missing + user ${userId} has no BYOK).`,
        );
      }
      throw err;
    }
    const r = await listHeygenAvatars({ userId, apiKey: heygenKey });
    if (!r.ok) {
      throw new NonRetriableError(
        `refresh-heygen-avatar-index: listHeygenAvatars failed — ${r.errorMessage ?? 'unknown'}`,
      );
    }
    // Polish-26.0.12 Commit 62.2: deep-strip the avatar array before
    // it crosses the Inngest step boundary. HeyGen v3 avatars have
    // optional fields (preview_video_url, premium, type, tags) — while
    // JSON.parse itself doesn't produce undefined keys, defense-in-
    // depth is cheap here and covers any future mapping/serialization
    // path that might inject one.
    return safeInngestStepReturn(r.avatars);
  });

  // Step B: diff against existing index.
  const diff = await guardedStepRun(step, 'diff-against-index', async () => {
    const db = getDb();
    const rows = await db.query.heygenAvatarIndex.findMany({
      columns: { avatarId: true, visionAnalyzedAt: true, deletedAt: true },
    });
    const buckets = bucketizeHeygen(liveAvatars, rows, Date.now(), forceAll);
    console.log(
      `[refresh-heygen-avatar-index:${trigger}] diff live=${liveAvatars.length} ` +
        `existing=${rows.length} toAnalyze=${buckets.toAnalyze.length} ` +
        `toTouchOnly=${buckets.toTouchOnly.length} ` +
        `toSoftDelete=${buckets.toSoftDelete.length} forceAll=${forceAll}`,
    );
    // Polish-26.0.12 Commit 62.2: deep-strip the diff return.
    // toAnalyzeAvatars carries HeygenAvatarV3 records with optional
    // fields — same reasoning as fetch-avatar-list. Everything
    // crossing an Inngest step boundary goes through the sanitizer.
    return safeInngestStepReturn({
      toAnalyzeIds: buckets.toAnalyze.map((a) => a.avatar_id),
      toAnalyzeAvatars: buckets.toAnalyze,
      toTouchOnlyIds: buckets.toTouchOnly.map((a) => a.avatar_id),
      toSoftDeleteIds: buckets.toSoftDelete,
      counts: {
        live: liveAvatars.length,
        existing: rows.length,
        toAnalyze: buckets.toAnalyze.length,
        toTouchOnly: buckets.toTouchOnly.length,
        toSoftDelete: buckets.toSoftDelete.length,
      },
    });
  });

  // Step C: soft-delete disappeared.
  //
  // Polish-26.0.12 Commit 62.2: explicit return value. Pre-fix this
  // step was `async () => { await db.update(...); }` — void callback
  // → promise resolves to undefined → JSON.stringify(undefined)
  // returns undefined → Inngest v3 flags UNDEFINED_VALUE at the
  // step-result boundary. safeInngestStepReturn maps a bare
  // undefined to { _void: true } but returning an actual summary
  // is both diagnostic-friendly and free.
  if (diff.toSoftDeleteIds.length > 0) {
    await guardedStepRun(step, 'mark-disappeared-deleted', async () => {
      const db = getDb();
      // Polish-26.0.13 Commit 62.3: postgres-js UNDEFINED_VALUE guard.
      // A single undefined element in the inArray list throws at the
      // driver boundary. Filter to defined strings + assert as tripwire.
      const ids = assertArrayNoUndefinedForPostgres(
        diff.toSoftDeleteIds,
        'refresh-heygen:mark-disappeared-deleted:inArray',
      );
      const setRecord = assertNoUndefinedForPostgres(
        { deletedAt: new Date() },
        'refresh-heygen:mark-disappeared-deleted:set',
      );
      await db
        .update(schema.heygenAvatarIndex)
        .set(setRecord)
        .where(inArray(schema.heygenAvatarIndex.avatarId, ids));
      return safeInngestStepReturn({ softDeleted: ids.length });
    });
  }

  // Step D + E (combined): chunked analyze + persist.
  //
  // Polish-26.0.2 Commit 61.2 added first-failure diagnostic dump +
  // consecutive-same-error early-exit after run 01KZAPKYZ03W6DA9ZE8D918BHY
  // hit 1264/1264 Gemini failures with an opaque "500 Internal error
  // encountered" — burned 20 minutes and left the operator blind.
  //
  // Polish-26.0.3 Commit 61.3 added URL-extension + magic-bytes
  // MIME inference to recover from HeyGen's CDN mis-serving WebP as
  // binary/octet-stream.
  //
  // Polish-26.0.4 Commit 61.4 CHUNKED this step. Pre-61.4 all 1264
  // avatars ran under ONE step.run('analyze-batch') that took
  // ~8-10 min wall-clock at concurrency 5. Vercel Hobby caps each
  // HTTP invocation at 60 seconds → FUNCTION_INVOCATION_TIMEOUT
  // before any output. Fix: split into N chunks of
  // HEYGEN_ANALYZE_CHUNK_SIZE avatars (default 12), each processed
  // by its own step.run('analyze-persist-chunk-K'). Inngest
  // schedules each chunk as a fresh 60s HTTP invocation, so total
  // sync runs ~30-45 min across many invocations but no single one
  // risks the ceiling.
  //
  // Persistence is INSIDE each chunk (not a separate persist-batch
  // step) so partial progress survives — if the sync fails mid-way,
  // already-analyzed avatars are already in heygen_avatar_index and
  // the next cycle's stale-scan skips them.
  //
  // Circuit-breaker (>=20 consecutive same-signature failures) is
  // enforced ACROSS chunks in the outer loop below, using
  // deterministic cumulative state reconstructed from cached
  // step.run results on Inngest replay.
  const chunkSize = resolveHeygenAnalyzeChunkSize();
  const chunks = chunkArray(diff.toAnalyzeAvatars, chunkSize);
  console.log(
    `[refresh-heygen-avatar-index:${trigger}] splitting ${diff.toAnalyzeAvatars.length} ` +
      `avatars into ${chunks.length} chunks of ${chunkSize} for Vercel Hobby 60s ceiling`,
  );

  // Ensure the Gemini BYOK check fails LOUDLY in a tiny step.run
  // before we start scheduling per-chunk work — otherwise a bad-key
  // failure would only surface on chunk 0's much larger invocation.
  if (diff.toAnalyzeAvatars.length > 0) {
    await guardedStepRun(step, 'preflight-gemini-key', async () => {
      try {
        await loadDecryptedKeys(userId, ['gemini']);
        // Polish-26.0.12 Commit 62.2: safeInngestStepReturn even
        // for well-formed returns — the sync worker's convention
        // is every step return goes through the sanitizer, so a
        // future edit that inadvertently returns undefined is
        // caught at the boundary rather than at UNDEFINED_VALUE.
        return safeInngestStepReturn({ ok: true });
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          throw new NonRetriableError(
            `refresh-heygen-avatar-index: Gemini BYOK missing for refresh user ${userId}. ` +
              `${err.message}. Vision analysis needs Gemini.`,
          );
        }
        throw err;
      }
    });
  }

  type FailureSample = {
    avatarId: string;
    avatarName: string;
    previewUrl: string;
    errorMessage: string;
    signature: string;
    /** Diagnostics from the analyzer (mime info, gemini raw body) when the
     *  failure happened before/during the Gemini call. */
    diagnostics: NonNullable<
      Awaited<ReturnType<typeof analyzeMakeugcAvatarThumbnail>>['diagnostics']
    > | null;
    /** Polish-26.0.10 Commit 62: field-level Zod issues when the failure
     *  was schema-side (parser could not coerce). Null for non-schema
     *  failures (mime, fetch, gemini-500). */
    schemaFieldIssues: string[] | null;
    /** First ~400 chars of the raw Gemini JSON that failed, when the
     *  failure was schema-side. Null otherwise. */
    schemaRawSnapshot: string | null;
  };

  type ChunkResult = {
    attempted: number;
    successful: number;
    failed: number;
    coerced: number;
    persisted: number;
    costUsd: number;
    /** Per-avatar error signature (null on success). Compact enough to
     *  cross the step.run serialization boundary for cross-chunk
     *  circuit-breaker continuity. */
    resultSigs: (string | null)[];
    /** Distinct-signature failure samples from this chunk (max one per
     *  signature). Outer loop merges + caps to DISTINCT_FAILURE_SAMPLE_CAP. */
    chunkFailureSamples: FailureSample[];
  };

  // Cumulative state — deterministic-across-replays because
  // step.run() results are cached and this outer loop just reads
  // them back in fixed order.
  let cumAttempted = 0;
  let cumSuccessful = 0;
  let cumFailed = 0;
  let cumCoerced = 0;
  let cumPersisted = 0;
  let cumCostUsd = 0;
  const cumFailureSamplesBySig = new Map<string, FailureSample>();
  let cumConsecutiveFailures = 0;
  let cumLastSignature: string | null = null;
  let cumEarlyExitAtChunk: number | null = null;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    if (cumEarlyExitAtChunk !== null) break;
    const chunk = chunks[chunkIdx]!;
    const chunkNumber = chunkIdx + 1;
    const chunkResult: ChunkResult = await guardedStepRun(
      step,
      `analyze-persist-chunk-${chunkIdx}`,
      async () => {
        // Preflight already ran a Gemini-key check (see above the
        // loop), so loadDecryptedKeys here should not surprise us —
        // but keep the guard: an ops-side revoke between chunks
        // still needs to fail loud.
        const keys = await loadDecryptedKeys(userId, ['gemini']);

        type ChunkRowOutcome = {
          avatar: (typeof chunk)[number];
          r: Awaited<ReturnType<typeof analyzeMakeugcAvatarThumbnail>> | null;
          /** Post-diagnostic-parser result: coerced-or-strict analysis, or null on hard fail. */
          analysis: MakeugcAvatarVisionAnalysis | null;
          /** Polish-26.0.10 Commit 62: coercion notes when the strict
           *  Zod parse failed but the coercion layer recovered a
           *  usable analysis. Empty array on strict success. */
          coercionsApplied: string[];
          /** Polish-26.0.10 Commit 62: split-signature failure detail
           *  when the diagnostic parser could not coerce. Null on
           *  success and on non-schema failures. */
          schemaFailure: {
            signature: string;
            reason: string;
            fieldIssues: string[];
            rawSnapshot: string;
          } | null;
          skipReason: string | null;
        };

        const outcomes = await runWithConcurrency(
          chunk,
          VISION_CONCURRENCY,
          async (avatar): Promise<ChunkRowOutcome> => {
            if (!avatar.preview_image_url || avatar.preview_image_url.length === 0) {
              return {
                avatar,
                r: null,
                analysis: null,
                coercionsApplied: [],
                schemaFailure: null,
                skipReason: 'no preview_image_url',
              };
            }
            const r = await analyzeMakeugcAvatarThumbnail({
              userId,
              apiKey: keys.gemini!,
              imageUrl: avatar.preview_image_url,
              systemPrompt: MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT,
            });
            if (!r.ok) {
              return {
                avatar,
                r,
                analysis: null,
                coercionsApplied: [],
                schemaFailure: null,
                skipReason: null,
              };
            }
            const parsed = parseMakeugcAvatarVisionAnalysisWithDiagnostics(r.parsedJson);
            if (parsed.ok) {
              return {
                avatar,
                r,
                analysis: parsed.analysis,
                coercionsApplied: parsed.coercionsApplied,
                schemaFailure: null,
                skipReason: null,
              };
            }
            return {
              avatar,
              r,
              analysis: null,
              coercionsApplied: [],
              schemaFailure: parsed.failure,
              skipReason: null,
            };
          },
        );

        // Fold concurrency-runner errors into ChunkRowOutcome shape.
        const rows: ChunkRowOutcome[] = outcomes.map((o) =>
          o.ok
            ? o.result
            : ({
                avatar: {
                  avatar_id: '(unknown)',
                  avatar_name: '',
                  gender: '',
                  preview_image_url: '',
                } as (typeof chunk)[number],
                r: null,
                analysis: null,
                coercionsApplied: [],
                schemaFailure: null,
                skipReason: `concurrency-runner-error: ${o.error}`,
              } as ChunkRowOutcome),
        );

        // Persist successful analyses IMMEDIATELY inside this step so
        // partial progress survives a mid-sync failure. Batch as one
        // per-row upsert (Postgres handles ~12 tiny upserts well
        // within the 60s window even sequentially).
        const db = getDb();
        const now = new Date();
        let persistedInChunk = 0;
        let skippedNoAvatarId = 0;
        for (const row of rows) {
          if (!row.analysis) continue;
          const a = row.analysis;
          // Polish-26.0.13 Commit 62.3: guard the primary key at
          // source. HeyGen's list API defines avatar_id as required
          // but the wire response has been observed missing it for
          // certain photo-avatar variants — a missing PK would
          // silently drop through stripUndefined and then either
          // trip postgres-js UNDEFINED_VALUE (on the ON CONFLICT
          // target) or a NOT NULL constraint. Skip + log instead.
          const avatarId = row.avatar.avatar_id;
          if (typeof avatarId !== 'string' || avatarId.length === 0) {
            skippedNoAvatarId++;
            console.error(
              `[refresh-heygen-avatar-index:${trigger}] chunk ${chunkNumber}: skipping avatar ` +
                `with missing/empty avatar_id — name=${JSON.stringify(row.avatar.avatar_name).slice(0, 80)} ` +
                `preview_url=${JSON.stringify(row.avatar.preview_image_url).slice(0, 200)}`,
            );
            continue;
          }
          // Polish-26.0.11 Commit 62.1: build the record once with
          // explicit `?? null` on every nullable column, then strip
          // any residual undefined keys before Drizzle.
          //
          // Polish-26.0.13 Commit 62.3: assertNoUndefinedForPostgres
          // tripwire BEFORE the driver sees the record — throws with
          // field name + full snapshot so an operator gets the actual
          // failing row instead of postgres-js's opaque "Undefined
          // values are not allowed".
          const record = assertNoUndefinedForPostgres(
            stripUndefined({
              avatarId,
              avatarName: row.avatar.avatar_name ?? '',
              thumbnailUrl: row.avatar.preview_image_url ?? '',
              heygenGender: (row.avatar.gender ?? '').toLowerCase(),
              ageBucket: a.age_bucket,
              ethnicity: a.ethnicity,
              hairColor: a.hair_color,
              hairStyle: a.hair_style ?? null,
              facialHair: a.facial_hair ?? null,
              wardrobeStyle: a.wardrobe_style ?? null,
              wardrobeSummary: a.wardrobe_summary ?? null,
              backgroundSetting: a.background_setting ?? null,
              visionAnalysisRaw: (row.r?.parsedJson ?? null) as Record<string, unknown> | null,
              visionAnalyzedAt: now,
              lastRefreshedAt: now,
              deletedAt: null,
            }),
            `refresh-heygen:persist-avatar:${avatarId}`,
          );
          await db
            .insert(schema.heygenAvatarIndex)
            .values(record as typeof schema.heygenAvatarIndex.$inferInsert)
            .onConflictDoUpdate({
              target: schema.heygenAvatarIndex.avatarId,
              set: record,
            });
          persistedInChunk++;
        }
        if (skippedNoAvatarId > 0) {
          console.warn(
            `[refresh-heygen-avatar-index:${trigger}] chunk ${chunkNumber}: ` +
              `skipped ${skippedNoAvatarId} avatar(s) with missing avatar_id`,
          );
        }

        // Polish-26.0.10 Commit 62: split-signature failure capture.
        // Distinct-signature samples let the outer summary carry one
        // exemplar per drift pattern (up to DISTINCT_FAILURE_SAMPLE_CAP
        // total) instead of only the first-ever failure — giving the
        // operator visibility into every root cause in one run.
        const chunkFailureSamplesBySig = new Map<string, FailureSample>();
        const resultSigs: (string | null)[] = [];
        let successful = 0;
        let failed = 0;
        let coerced = 0;
        let costUsd = 0;
        for (const row of rows) {
          const isFailure = !row.analysis;
          if (isFailure) failed++;
          else {
            successful++;
            if (row.coercionsApplied.length > 0) coerced++;
          }
          costUsd += row.r?.costUsd ?? 0;
          if (!isFailure) {
            resultSigs.push(null);
            continue;
          }
          // Signature classification, split by root cause:
          //   - skip:<reason>          — preview-URL missing etc.
          //   - concurrency-runner-error:...
          //   - mime-filter:<mime>     — image rejected pre-Gemini
          //   - image-fetch:<status>   — CDN HTTP failure
          //   - gemini:<status>        — Gemini API non-200
          //   - schema:<fields>        — from diagnostic parser
          //   - unknown                — should not happen; catch-all
          let signature: string;
          let errorMessage: string;
          if (row.skipReason) {
            signature = `skip:${errorSignature(row.skipReason)}`;
            errorMessage = row.skipReason;
          } else if (row.schemaFailure) {
            signature = row.schemaFailure.signature;
            errorMessage = `schema-fail: ${row.schemaFailure.reason}. issues=${row.schemaFailure.fieldIssues.slice(0, 3).join(' | ')}`;
          } else if (row.r && !row.r.ok) {
            const failedAt = row.r.diagnostics?.failedAt ?? 'gemini';
            const detail =
              failedAt === 'mime-filter'
                ? `mime-filter:${row.r.diagnostics?.imageMime ?? '?'}`
                : failedAt === 'image-fetch'
                  ? `image-fetch:${row.r.diagnostics?.imageFetchStatus ?? '?'}`
                  : failedAt === 'parse'
                    ? 'gemini:empty-response'
                    : `gemini:${row.r.diagnostics?.geminiStatus ?? '?'}`;
            signature = detail;
            errorMessage = row.r.errorMessage ?? 'unknown';
          } else {
            signature = 'unknown';
            errorMessage = 'unknown';
          }
          resultSigs.push(signature);
          if (row.avatar.preview_image_url && !chunkFailureSamplesBySig.has(signature)) {
            // Polish-26.0.11 Commit 62.1: explicit `?? null` on every
            // nullable field + deep-strip on the diagnostics object.
            // Diagnostics comes from analyzeMakeugcAvatarThumbnail
            // where a spread like `geminiStatus: result.status` can
            // leak an undefined-valued key when the underlying HTTP
            // response has no status field — Inngest's step-result
            // serializer would then throw UNDEFINED_VALUE.
            const rawDiagnostics = row.r?.diagnostics ?? null;
            const cleanDiagnostics =
              rawDiagnostics == null ? null : stripUndefinedDeep(rawDiagnostics);
            chunkFailureSamplesBySig.set(signature, {
              avatarId: row.avatar.avatar_id ?? '(unknown)',
              avatarName: row.avatar.avatar_name ?? '',
              previewUrl: row.avatar.preview_image_url,
              errorMessage: errorMessage ?? 'unknown',
              signature,
              diagnostics: cleanDiagnostics as FailureSample['diagnostics'],
              schemaFieldIssues: row.schemaFailure?.fieldIssues ?? null,
              schemaRawSnapshot: row.schemaFailure?.rawSnapshot ?? null,
            });
          }
        }
        const attempted = rows.length;
        console.log(
          `[refresh-heygen-avatar-index:${trigger}] chunk ${chunkNumber}/${chunks.length}: ` +
            `attempted=${attempted} successful=${successful} coerced=${coerced} failed=${failed} ` +
            `persisted=${persistedInChunk} costUsd=${costUsd.toFixed(4)}`,
        );
        // Polish-26.0.11/12 Commit 62.1/62.2: safeInngestStepReturn
        // combines the deep-strip (Commit 62.1) with the void→
        // sentinel coercion (Commit 62.2). Belt-and-suspenders — even
        // if a future refactor makes this branch return undefined,
        // the sanitizer covers it before Inngest sees it.
        return safeInngestStepReturn({
          attempted,
          successful,
          failed,
          coerced,
          persisted: persistedInChunk,
          costUsd,
          resultSigs,
          chunkFailureSamples: Array.from(chunkFailureSamplesBySig.values()),
        }) as ChunkResult;
      },
    );

    // Outer-loop cumulative-state update.
    cumAttempted += chunkResult.attempted;
    cumSuccessful += chunkResult.successful;
    cumFailed += chunkResult.failed;
    cumCoerced += chunkResult.coerced;
    cumPersisted += chunkResult.persisted;
    cumCostUsd += chunkResult.costUsd;
    // Polish-26.0.10 Commit 62: merge per-signature failure samples.
    // First occurrence of each signature wins; cap at
    // DISTINCT_FAILURE_SAMPLE_CAP so the summary payload stays small.
    for (const sample of chunkResult.chunkFailureSamples) {
      if (cumFailureSamplesBySig.size >= DISTINCT_FAILURE_SAMPLE_CAP) break;
      if (cumFailureSamplesBySig.has(sample.signature)) continue;
      cumFailureSamplesBySig.set(sample.signature, sample);
      console.error(
        `[refresh-heygen-avatar-index:${trigger}] FAILURE-SAMPLE ` +
          `signature=${sample.signature} ` +
          `avatar_id=${sample.avatarId} ` +
          `preview_url=${sample.previewUrl.slice(0, 250)} ` +
          `error=${JSON.stringify(sample.errorMessage).slice(0, 500)} ` +
          `diagnostics=${JSON.stringify(sample.diagnostics)} ` +
          `schema_field_issues=${JSON.stringify(sample.schemaFieldIssues)} ` +
          `schema_raw_snapshot=${JSON.stringify(sample.schemaRawSnapshot)}`,
      );
    }

    // Cross-chunk consecutive-failure circuit breaker. The `sig`
    // stream is contiguous across chunk boundaries — a same-signature
    // streak that spans chunk 3 → chunk 4 counts as one streak.
    for (const sig of chunkResult.resultSigs) {
      if (sig === null) {
        cumConsecutiveFailures = 0;
        cumLastSignature = null;
        continue;
      }
      if (sig === cumLastSignature) {
        cumConsecutiveFailures++;
      } else {
        cumConsecutiveFailures = 1;
        cumLastSignature = sig;
      }
      if (cumConsecutiveFailures >= CROSS_CHUNK_CONSECUTIVE_FAILURE_THRESHOLD) {
        cumEarlyExitAtChunk = chunkIdx;
        console.error(
          `[refresh-heygen-avatar-index:${trigger}] EARLY-EXIT at chunk ${chunkNumber}: ` +
            `${CROSS_CHUNK_CONSECUTIVE_FAILURE_THRESHOLD} consecutive same-signature failures ` +
            `across chunks — aborting remaining ${chunks.length - chunkNumber} chunk(s). ` +
            `Signature: ${JSON.stringify(sig).slice(0, 300)}. ` +
            `See FIRST FAILURE log above for the actionable diagnostics.`,
        );
        break;
      }
    }
  }

  // Convenience alias so the summary + touch step read consistently
  // regardless of whether Step D+E was chunked or not.
  const failureSamples = Array.from(cumFailureSamplesBySig.values());
  const analyzed = {
    attempted: cumAttempted,
    successful: cumSuccessful,
    failed: cumFailed,
    coerced: cumCoerced,
    earlyExit: cumEarlyExitAtChunk !== null,
    // Polish-26.0.10 Commit 62: `firstFailure` retained for back-compat
    // with any log parsers keyed on that field. It's just the first of
    // the distinct-signature samples now.
    firstFailure: failureSamples[0] ?? null,
    failureSamples,
  };
  const persistedCount = cumPersisted;

  // Step F: touch unchanged fresh rows.
  //
  // Polish-26.0.12 Commit 62.2: explicit return value — same
  // reasoning as mark-disappeared-deleted above. This is the SECOND
  // void step Inngest was tripping UNDEFINED_VALUE on post-26.0.11.
  if (diff.toTouchOnlyIds.length > 0) {
    await guardedStepRun(step, 'touch-fresh-rows', async () => {
      const db = getDb();
      // Polish-26.0.13 Commit 62.3: same postgres-js UNDEFINED_VALUE
      // guards as mark-disappeared-deleted.
      const ids = assertArrayNoUndefinedForPostgres(
        diff.toTouchOnlyIds,
        'refresh-heygen:touch-fresh-rows:inArray',
      );
      const setRecord = assertNoUndefinedForPostgres(
        { lastRefreshedAt: new Date() },
        'refresh-heygen:touch-fresh-rows:set',
      );
      await db
        .update(schema.heygenAvatarIndex)
        .set(setRecord)
        .where(
          and(
            inArray(schema.heygenAvatarIndex.avatarId, ids),
            isNull(schema.heygenAvatarIndex.deletedAt),
          ),
        );
      return safeInngestStepReturn({ touched: ids.length });
    });
  }

  // Polish-26.0.11 Commit 62.1: the raw summary object is built here
  // and then deep-stripped at the return statement below. Everything
  // between must be defined-or-null (never bare `undefined`); the
  // deep strip is belt-and-suspenders for the failure-samples
  // sub-tree which carries nested diagnostics from Gemini.
  const summary = {
    polishVersion: POLISH_VERSION,
    trigger,
    durationMs: Date.now() - startedAt,
    counts: diff.counts,
    analyzeAttempted: analyzed.attempted,
    analyzeSuccessful: analyzed.successful,
    // Polish-26.0.10 Commit 62: subset of successful — how many needed
    // the coercion layer to normalize Gemini output before Zod
    // acceptance. Elevated coerced count => refine strict prompts.
    analyzeCoerced: analyzed.coerced,
    analyzeFailed: analyzed.failed,
    persistedCount,
    totalGeminiCostUsd: Number(cumCostUsd.toFixed(6)),
    staleThresholdMs: STALE_MS,
    forceAll,
    refreshUserId: userId,
    // Polish-26.0.4 Commit 61.4: chunking stats. earlyExitAtChunk
    // is the 0-indexed chunk that tripped the cross-chunk circuit
    // breaker (null when the whole sync ran cleanly).
    chunkSize: resolveHeygenAnalyzeChunkSize(),
    totalChunks: chunks.length,
    ...(cumEarlyExitAtChunk !== null ? { earlyExitAtChunk: cumEarlyExitAtChunk } : {}),
    // Polish-26.0.2 Commit 61.2: surface early-exit + first-failure
    // in the Inngest run summary so the operator sees the actionable
    // diagnostic without opening Runtime Logs. When earlyExit=true,
    // firstFailure carries the URL / MIME / geminiRawBodyExcerpt
    // that identifies the root cause.
    earlyExit: analyzed.earlyExit,
    firstFailure: analyzed.firstFailure,
    // Polish-26.0.10 Commit 62: distinct-signature failure samples
    // (up to DISTINCT_FAILURE_SAMPLE_CAP) so an operator sees every
    // root cause in one run instead of only the first-ever failure.
    // Signatures now split by drift pattern (schema:ethnicity vs
    // schema:background_setting vs mime-filter:image/gif, etc.).
    failureSamples: analyzed.failureSamples,
  };
  // Polish-26.0.11/12 Commit 62.1/62.2: safeInngestStepReturn is
  // deep-strip + void-coerce. Same rationale as per-chunk return.
  const cleanSummary = safeInngestStepReturn(summary);
  console.log(
    `[refresh-heygen-avatar-index:${trigger}] cycle complete ${JSON.stringify(cleanSummary)}`,
  );
  return cleanSummary as Record<string, unknown>;
}

export const refreshHeygenAvatarIndexCron = inngest.createFunction(
  {
    id: 'refresh-heygen-avatar-index-cron',
    name: 'Polish-26: refresh HeyGen enriched avatar index (cron)',
    retries: 1,
  },
  { cron: '0 4 * * *' }, // 1h after MakeUGC cron to stagger Gemini load
  async ({ step }) => {
    const startedAt = Date.now();
    try {
      const userId = await guardedStepRun(step, 'resolve-refresh-user', async () => {
        return resolveHeygenRefreshUserId(undefined);
      });
      return await refreshHeygenAvatarIndexCore({
        step,
        userId,
        forceAll: false,
        startedAt,
        trigger: 'cron',
      });
    } catch (err) {
      // Polish-26.0.14 Commit 62.4: unique marker + full raw shape
      // dump. If the operator sees "OUTER-CATCH-CRON-M14" in Vercel
      // logs, this catch fired — the raw shape reveals what err
      // actually looks like (Inngest's wrapper class, cause chain,
      // etc). If the marker is absent, the catch is being bypassed
      // and the error is emitted before it can reach here.
      console.error(
        `[refreshHeygenAvatarIndexCron] OUTER-CATCH-CRON-M14 raw: ` +
          JSON.stringify(safeErrorShape(err)).slice(0, 3000),
      );
      rethrowWithUndefinedContext(err, 'refreshHeygenAvatarIndexCron');
    }
  },
);

export const refreshHeygenAvatarIndexManual = inngest.createFunction(
  {
    id: 'refresh-heygen-avatar-index',
    name: 'Polish-26: refresh HeyGen enriched avatar index',
    retries: 1,
  },
  { event: 'heygen/avatar-index.refresh.requested' },
  async ({ event, step }) => {
    const startedAt = Date.now();
    try {
      const data = (event?.data ?? {}) as RefreshEventData;
      const forceAll = data.forceAll === true;
      const userId = await guardedStepRun(step, 'resolve-refresh-user', async () => {
        return resolveHeygenRefreshUserId(data.userId);
      });
      return await refreshHeygenAvatarIndexCore({
        step,
        userId,
        forceAll,
        startedAt,
        trigger: 'manual',
      });
    } catch (err) {
      // Polish-26.0.14 Commit 62.4: unique marker + raw shape dump —
      // see refreshHeygenAvatarIndexCron above for the diagnostic
      // convention. Marker: OUTER-CATCH-MANUAL-M14.
      console.error(
        `[refreshHeygenAvatarIndexManual] OUTER-CATCH-MANUAL-M14 raw: ` +
          JSON.stringify(safeErrorShape(err)).slice(0, 3000),
      );
      rethrowWithUndefinedContext(err, 'refreshHeygenAvatarIndexManual');
    }
  },
);
