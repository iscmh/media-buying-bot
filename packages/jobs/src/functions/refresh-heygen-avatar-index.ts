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
import {
  MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT,
  parseMakeugcAvatarVisionAnalysis,
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

const CROSS_CHUNK_CONSECUTIVE_FAILURE_THRESHOLD = 20;

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
  const { step, userId, forceAll, startedAt, trigger } = params;

  // Step A: fetch live library.
  const liveAvatars = await step.run('fetch-avatar-list', async () => {
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
    return r.avatars;
  });

  // Step B: diff against existing index.
  const diff = await step.run('diff-against-index', async () => {
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
    return {
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
    };
  });

  // Step C: soft-delete disappeared.
  if (diff.toSoftDeleteIds.length > 0) {
    await step.run('mark-disappeared-deleted', async () => {
      const db = getDb();
      await db
        .update(schema.heygenAvatarIndex)
        .set({ deletedAt: new Date() })
        .where(inArray(schema.heygenAvatarIndex.avatarId, diff.toSoftDeleteIds));
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
    await step.run('preflight-gemini-key', async () => {
      try {
        await loadDecryptedKeys(userId, ['gemini']);
        return { ok: true };
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

  type ChunkResult = {
    attempted: number;
    successful: number;
    failed: number;
    persisted: number;
    costUsd: number;
    /** Per-avatar error signature (null on success). Compact enough to
     *  cross the step.run serialization boundary for cross-chunk
     *  circuit-breaker continuity. */
    resultSigs: (string | null)[];
    /** First failure this chunk saw (null if none / not this chunk's
     *  turn to capture). Outer loop keeps only the FIRST non-null. */
    chunkFirstFailure: {
      avatarId: string;
      avatarName: string;
      previewUrl: string;
      errorMessage: string;
      diagnostics: NonNullable<
        Awaited<ReturnType<typeof analyzeMakeugcAvatarThumbnail>>['diagnostics']
      > | null;
    } | null;
  };

  // Cumulative state — deterministic-across-replays because
  // step.run() results are cached and this outer loop just reads
  // them back in fixed order.
  let cumAttempted = 0;
  let cumSuccessful = 0;
  let cumFailed = 0;
  let cumPersisted = 0;
  let cumCostUsd = 0;
  let cumFirstFailure: ChunkResult['chunkFirstFailure'] = null;
  let cumConsecutiveFailures = 0;
  let cumLastSignature: string | null = null;
  let cumEarlyExitAtChunk: number | null = null;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    if (cumEarlyExitAtChunk !== null) break;
    const chunk = chunks[chunkIdx]!;
    const chunkNumber = chunkIdx + 1;
    const chunkResult: ChunkResult = await step.run(
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
          analysis: ReturnType<typeof parseMakeugcAvatarVisionAnalysis>;
          skipReason: string | null;
        };

        const outcomes = await runWithConcurrency(
          chunk,
          VISION_CONCURRENCY,
          async (avatar): Promise<ChunkRowOutcome> => {
            if (!avatar.preview_image_url || avatar.preview_image_url.length === 0) {
              return { avatar, r: null, analysis: null, skipReason: 'no preview_image_url' };
            }
            const r = await analyzeMakeugcAvatarThumbnail({
              userId,
              apiKey: keys.gemini!,
              imageUrl: avatar.preview_image_url,
              systemPrompt: MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT,
            });
            const analysis = r.ok ? parseMakeugcAvatarVisionAnalysis(r.parsedJson) : null;
            return { avatar, r, analysis, skipReason: null };
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
        for (const row of rows) {
          if (!row.analysis) continue;
          const a = row.analysis;
          await db
            .insert(schema.heygenAvatarIndex)
            .values({
              avatarId: row.avatar.avatar_id,
              avatarName: row.avatar.avatar_name,
              thumbnailUrl: row.avatar.preview_image_url ?? '',
              heygenGender: (row.avatar.gender ?? '').toLowerCase(),
              ageBucket: a.age_bucket,
              ethnicity: a.ethnicity,
              hairColor: a.hair_color,
              hairStyle: a.hair_style,
              facialHair: a.facial_hair,
              wardrobeStyle: a.wardrobe_style,
              wardrobeSummary: a.wardrobe_summary,
              backgroundSetting: a.background_setting,
              visionAnalysisRaw: (row.r?.parsedJson ?? null) as Record<string, unknown> | null,
              visionAnalyzedAt: now,
              lastRefreshedAt: now,
              deletedAt: null,
            })
            .onConflictDoUpdate({
              target: schema.heygenAvatarIndex.avatarId,
              set: {
                avatarName: row.avatar.avatar_name,
                thumbnailUrl: row.avatar.preview_image_url ?? '',
                heygenGender: (row.avatar.gender ?? '').toLowerCase(),
                ageBucket: a.age_bucket,
                ethnicity: a.ethnicity,
                hairColor: a.hair_color,
                hairStyle: a.hair_style,
                facialHair: a.facial_hair,
                wardrobeStyle: a.wardrobe_style,
                wardrobeSummary: a.wardrobe_summary,
                backgroundSetting: a.background_setting,
                visionAnalysisRaw: (row.r?.parsedJson ?? null) as Record<string, unknown> | null,
                visionAnalyzedAt: now,
                lastRefreshedAt: now,
                deletedAt: null,
              },
            });
          persistedInChunk++;
        }

        // Build the compact chunk result. resultSigs feeds cross-chunk
        // circuit-breaker continuity in the outer loop.
        let chunkFirstFailure: ChunkResult['chunkFirstFailure'] = null;
        const resultSigs: (string | null)[] = [];
        let successful = 0;
        let failed = 0;
        let costUsd = 0;
        for (const row of rows) {
          const isFailure = !row.analysis;
          if (isFailure) failed++;
          else successful++;
          costUsd += row.r?.costUsd ?? 0;
          if (isFailure) {
            const rawMsg = row.skipReason
              ? row.skipReason
              : row.r?.ok === false
                ? (row.r.errorMessage ?? 'unknown')
                : 'JSON did not match schema';
            resultSigs.push(errorSignature(rawMsg));
            if (chunkFirstFailure === null && row.avatar.preview_image_url) {
              chunkFirstFailure = {
                avatarId: row.avatar.avatar_id,
                avatarName: row.avatar.avatar_name,
                previewUrl: row.avatar.preview_image_url,
                errorMessage: rawMsg,
                diagnostics: row.r?.diagnostics ?? null,
              };
            }
          } else {
            resultSigs.push(null);
          }
        }
        const attempted = rows.length;
        console.log(
          `[refresh-heygen-avatar-index:${trigger}] chunk ${chunkNumber}/${chunks.length}: ` +
            `attempted=${attempted} successful=${successful} failed=${failed} ` +
            `persisted=${persistedInChunk} costUsd=${costUsd.toFixed(4)}`,
        );
        return {
          attempted,
          successful,
          failed,
          persisted: persistedInChunk,
          costUsd,
          resultSigs,
          chunkFirstFailure,
        };
      },
    );

    // Outer-loop cumulative-state update.
    cumAttempted += chunkResult.attempted;
    cumSuccessful += chunkResult.successful;
    cumFailed += chunkResult.failed;
    cumPersisted += chunkResult.persisted;
    cumCostUsd += chunkResult.costUsd;
    if (cumFirstFailure === null && chunkResult.chunkFirstFailure) {
      cumFirstFailure = chunkResult.chunkFirstFailure;
      console.error(
        `[refresh-heygen-avatar-index:${trigger}] FIRST FAILURE ` +
          `avatar_id=${cumFirstFailure.avatarId} ` +
          `preview_url=${cumFirstFailure.previewUrl.slice(0, 250)} ` +
          `error=${JSON.stringify(cumFirstFailure.errorMessage).slice(0, 500)} ` +
          `diagnostics=${JSON.stringify(cumFirstFailure.diagnostics)}`,
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
  const analyzed = {
    attempted: cumAttempted,
    successful: cumSuccessful,
    failed: cumFailed,
    earlyExit: cumEarlyExitAtChunk !== null,
    firstFailure: cumFirstFailure,
  };
  const persistedCount = cumPersisted;

  // Step F: touch unchanged fresh rows.
  if (diff.toTouchOnlyIds.length > 0) {
    await step.run('touch-fresh-rows', async () => {
      const db = getDb();
      await db
        .update(schema.heygenAvatarIndex)
        .set({ lastRefreshedAt: new Date() })
        .where(
          and(
            inArray(schema.heygenAvatarIndex.avatarId, diff.toTouchOnlyIds),
            isNull(schema.heygenAvatarIndex.deletedAt),
          ),
        );
    });
  }

  const summary = {
    polishVersion: POLISH_VERSION,
    trigger,
    durationMs: Date.now() - startedAt,
    counts: diff.counts,
    analyzeAttempted: analyzed.attempted,
    analyzeSuccessful: analyzed.successful,
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
  };
  console.log(`[refresh-heygen-avatar-index:${trigger}] cycle complete ${JSON.stringify(summary)}`);
  return summary;
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
    const userId = await step.run('resolve-refresh-user', async () => {
      return resolveHeygenRefreshUserId(undefined);
    });
    return refreshHeygenAvatarIndexCore({
      step,
      userId,
      forceAll: false,
      startedAt,
      trigger: 'cron',
    });
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
    const data = (event?.data ?? {}) as RefreshEventData;
    const forceAll = data.forceAll === true;
    const userId = await step.run('resolve-refresh-user', async () => {
      return resolveHeygenRefreshUserId(data.userId);
    });
    return refreshHeygenAvatarIndexCore({
      step,
      userId,
      forceAll,
      startedAt,
      trigger: 'manual',
    });
  },
);
