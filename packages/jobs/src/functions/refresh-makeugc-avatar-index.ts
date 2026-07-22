/**
 * Polish-25 Commit 7 + 8 + 9: refresh of the enriched MakeUGC
 * avatar index.
 *
 * Polish-25 Commit 8 SPLIT what was one multi-trigger function
 * into TWO single-trigger functions that delegate to a shared
 * core (`refreshMakeugcAvatarIndexCore`).
 *
 * Polish-25 Commit 9 STICKY-ID FIX: after Commit 8 shipped,
 * Inngest cloud kept the Commit-7 manifest entry for
 * `refresh-makeugc-avatar-index` (bare id) — every route to the
 * split `-manual` id fired "No function ID found in request".
 * PUT-based force-sync rejected our deployId formats ("Invalid
 * deploy ID"), and Vercel redeploy didn't dislodge the stale
 * manifest. Pragmatic unstick: the event-triggered function
 * keeps the ORIGINAL bare id `refresh-makeugc-avatar-index` so
 * the stale manifest routes correctly; the cron function keeps
 * its distinct `-cron` id introduced by Commit 8.
 *
 *   refreshMakeugcAvatarIndexCron   — id: 'refresh-makeugc-avatar-index-cron'
 *                                     trigger: { cron: '0 3 * * *' }
 *                                     userId from MAKEUGC_REFRESH_USER_ID env
 *                                     forceAll:false
 *   refreshMakeugcAvatarIndexManual — id: 'refresh-makeugc-avatar-index'  ← bare
 *                                     trigger: { event: 'makeugc/avatar-index
 *                                                       .refresh.requested' }
 *                                     userId + forceAll from event.data
 *
 * The JS export name `refreshMakeugcAvatarIndexManual` is kept
 * for functions/index.ts wiring stability — only the Inngest
 * function id string changed. Both functions still delegate to
 * the shared `refreshMakeugcAvatarIndexCore`.
 *
 * Steps in the core (each its own step.run — Inngest retry
 * boundary):
 *   A. fetch-avatar-list        — GET /video/avatars (no gender
 *                                  filter → full library).
 *   B. diff-against-index       — split into new / stale (>7d) /
 *                                  unchanged / disappeared subsets.
 *   C. mark-disappeared-deleted — set deleted_at on rows no longer
 *                                  in the MakeUGC library.
 *   D. analyze-batch            — Gemini Vision on new + stale
 *                                  thumbnails, concurrency-limited
 *                                  to 5 parallel.
 *   E. persist-batch            — upsert enriched descriptors.
 *   F. touch-fresh-rows         — bump lastRefreshedAt on unchanged rows.
 *   G. return summary           — logged + returned as the function value.
 *
 * (Step A' — resolve-refresh-user — is now done at the wrapper layer
 * so the core always gets a real userId. Cron resolves from env;
 * manual resolves from event.data.)
 *
 * Cost budget: ~$0.001/thumbnail × ~500 avatars = ~$0.50 initial
 * build. Weekly stale refresh keeps ongoing spend near $0.50/week.
 */
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { NonRetriableError, type GetStepTools } from 'inngest';
import {
  analyzeMakeugcAvatarThumbnail,
  listMakeugcAvatars,
  type MakeugcAvatar,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { resolveMakeugcKey } from '../lib/resolve-makeugc-key';
import {
  MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT,
  parseMakeugcAvatarVisionAnalysis,
} from '../lib/makeugc-avatar-vision-prompt';

console.log(`[jobs.refresh-makeugc-avatar-index] cold start — POLISH_VERSION=${POLISH_VERSION}`);

// Concurrency + freshness knobs.
const VISION_CONCURRENCY = 5;
const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface RefreshEventData {
  /** Manual-dispatch user override. Cron ignores this. */
  userId?: string;
  /** Force re-analyze every row, not just new+stale. Manual-only. */
  forceAll?: boolean;
}

/**
 * Resolve which userId's BYOK we'll use for this refresh cycle.
 * Precedence:
 *   1. explicit event.data.userId (manual dispatch path)
 *   2. env MAKEUGC_REFRESH_USER_ID (cron path — must be set at
 *      deploy time to a real user's UUID)
 *   3. throw NonRetriableError (no userId → no keys → nothing to do)
 *
 * Exported so tests can pin the precedence rules directly without
 * spinning up an Inngest step context.
 */
export function resolveRefreshUserId(eventUserId: string | undefined): string {
  if (eventUserId && typeof eventUserId === 'string' && eventUserId.trim().length > 0) {
    return eventUserId.trim();
  }
  const envUserId = process.env['MAKEUGC_REFRESH_USER_ID']?.trim();
  if (envUserId && envUserId.length > 0) {
    return envUserId;
  }
  throw new NonRetriableError(
    'refresh-makeugc-avatar-index: no userId. Set MAKEUGC_REFRESH_USER_ID env for ' +
      'cron path, or pass { userId } in the manual event payload.',
  );
}

interface DiffBuckets {
  toAnalyze: MakeugcAvatar[]; // new + stale
  toTouchOnly: MakeugcAvatar[]; // present + fresh (< STALE_MS) → just bump last_refreshed_at
  toSoftDelete: string[]; // present-in-index, absent-in-MakeUGC
}

export function bucketize(
  liveAvatars: readonly MakeugcAvatar[],
  indexRows: readonly {
    avatarId: string;
    visionAnalyzedAt: Date;
    deletedAt: Date | null;
  }[],
  now: number,
  forceAll: boolean,
): DiffBuckets {
  const indexById = new Map<string, { visionAnalyzedAt: Date; deletedAt: Date | null }>();
  for (const r of indexRows) {
    indexById.set(r.avatarId, { visionAnalyzedAt: r.visionAnalyzedAt, deletedAt: r.deletedAt });
  }
  const toAnalyze: MakeugcAvatar[] = [];
  const toTouchOnly: MakeugcAvatar[] = [];
  const liveIds = new Set<string>();

  for (const a of liveAvatars) {
    liveIds.add(a.id);
    const prior = indexById.get(a.id);
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

/**
 * Concurrency-limited batch runner. Runs `worker` over `items`
 * with at most `limit` in flight. Preserves order in the output.
 * Any per-item throw is caught and returned as `{ ok: false, error }`
 * so a single flake doesn't kill the whole cycle.
 */
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
        out[idx] = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pump()));
  return out as Array<{ ok: true; result: R } | { ok: false; error: string }>;
}

type StepTools = GetStepTools<typeof inngest>;

export interface RefreshCoreParams {
  step: StepTools;
  userId: string;
  forceAll: boolean;
  /** Wrapper-side wall-clock start so summary.durationMs covers
   *  scheduling + resolve-user + core end-to-end. */
  startedAt: number;
  /** Trigger label — 'cron' or 'manual' — carried into the returned
   *  summary + cold-start log for dashboard forensics. */
  trigger: 'cron' | 'manual';
}

/**
 * Polish-25 Commit 8: the shared body of both Inngest functions.
 *
 * Same params + same work regardless of trigger — the wrapper's
 * only job is to resolve `userId` + `forceAll` and hand off here.
 */
export async function refreshMakeugcAvatarIndexCore(
  params: RefreshCoreParams,
): Promise<Record<string, unknown>> {
  const { step, userId, forceAll, startedAt, trigger } = params;

  // Step A: fetch live library.
  const liveAvatars = await step.run('fetch-avatar-list', async () => {
    // Polish-25.2 Commit 11: platform key preferred; user BYOK
    // falls back for dev environments where MAKEUGC_MANAGED_KEY
    // isn't set on the refresh user's context.
    let makeugcKey: string;
    try {
      const resolved = await resolveMakeugcKey({ userId });
      makeugcKey = resolved.apiKey;
    } catch (err) {
      if (err instanceof MissingProviderKeyError) {
        throw new NonRetriableError(
          `refresh-makeugc-avatar-index: no MakeUGC key available for refresh ` +
            `(env MAKEUGC_MANAGED_KEY missing + user ${userId} has no BYOK).`,
        );
      }
      throw err;
    }
    const r = await listMakeugcAvatars({ userId, apiKey: makeugcKey });
    if (!r.ok) {
      throw new NonRetriableError(
        `refresh-makeugc-avatar-index: listMakeugcAvatars failed — ` +
          `${r.errorMessage ?? 'unknown'}`,
      );
    }
    return r.avatars;
  });

  // Step B: diff against the existing index.
  const diff = await step.run('diff-against-index', async () => {
    const db = getDb();
    const rows = await db.query.makeugcAvatarIndex.findMany({
      columns: { avatarId: true, visionAnalyzedAt: true, deletedAt: true },
    });
    const buckets = bucketize(liveAvatars, rows, Date.now(), forceAll);
    console.log(
      `[refresh-makeugc-avatar-index:${trigger}] diff live=${liveAvatars.length} ` +
        `existing=${rows.length} toAnalyze=${buckets.toAnalyze.length} ` +
        `toTouchOnly=${buckets.toTouchOnly.length} ` +
        `toSoftDelete=${buckets.toSoftDelete.length} forceAll=${forceAll}`,
    );
    return {
      toAnalyzeIds: buckets.toAnalyze.map((a) => a.id),
      toAnalyzeAvatars: buckets.toAnalyze,
      toTouchOnlyIds: buckets.toTouchOnly.map((a) => a.id),
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

  // Step C: soft-delete rows that disappeared from MakeUGC.
  if (diff.toSoftDeleteIds.length > 0) {
    await step.run('mark-disappeared-deleted', async () => {
      const db = getDb();
      await db
        .update(schema.makeugcAvatarIndex)
        .set({ deletedAt: new Date() })
        .where(inArray(schema.makeugcAvatarIndex.avatarId, diff.toSoftDeleteIds));
    });
  }

  // Step D: analyze thumbnails.
  const analyzed = await step.run('analyze-batch', async () => {
    if (diff.toAnalyzeAvatars.length === 0) {
      return { attempted: 0, successful: 0, failed: 0, results: [] };
    }
    // Polish-25.2 Commit 11: MakeUGC is platform-managed so we no
    // longer need a MakeUGC row for the analyze batch; only Gemini
    // BYOK is required here (the vision-analysis pass uses the
    // refresh user's Gemini key). The listMakeugcAvatars call
    // above already resolved the MakeUGC key via
    // resolveMakeugcKey; the analyze step doesn't touch MakeUGC.
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) {
        throw new NonRetriableError(
          `refresh-makeugc-avatar-index: Gemini BYOK missing for refresh user ${userId}. ` +
            `${err.message}. Vision analysis needs Gemini.`,
        );
      }
      throw err;
    }
    type AnalyzedRow = {
      avatarId: string;
      avatarName: string;
      thumbnailUrl: string;
      makeugcGender: string;
      analysis: ReturnType<typeof parseMakeugcAvatarVisionAnalysis>;
      rawJson: unknown;
      rawText: string | undefined;
      costUsd: number;
      errorMessage: string | undefined;
    };
    const outcomes = await runWithConcurrency(
      diff.toAnalyzeAvatars,
      VISION_CONCURRENCY,
      async (avatar): Promise<AnalyzedRow> => {
        if (!avatar.thumbnail || avatar.thumbnail.length === 0) {
          return {
            avatarId: avatar.id,
            avatarName: avatar.name,
            thumbnailUrl: '',
            makeugcGender: avatar.gender ?? '',
            analysis: null,
            rawJson: undefined,
            rawText: undefined,
            costUsd: 0,
            errorMessage: 'no thumbnail URL — skipped',
          };
        }
        const r = await analyzeMakeugcAvatarThumbnail({
          userId,
          apiKey: keys.gemini!,
          imageUrl: avatar.thumbnail,
          systemPrompt: MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT,
        });
        const analysis = r.ok ? parseMakeugcAvatarVisionAnalysis(r.parsedJson) : null;
        return {
          avatarId: avatar.id,
          avatarName: avatar.name,
          thumbnailUrl: avatar.thumbnail,
          makeugcGender: avatar.gender ?? '',
          analysis,
          rawJson: r.parsedJson,
          rawText: r.rawText,
          costUsd: r.costUsd,
          errorMessage: r.ok
            ? analysis
              ? undefined
              : 'JSON did not match schema'
            : r.errorMessage,
        };
      },
    );
    const results = outcomes.map((o) =>
      o.ok
        ? o.result
        : ({
            avatarId: '(unknown)',
            avatarName: '',
            thumbnailUrl: '',
            makeugcGender: '',
            analysis: null,
            rawJson: undefined,
            rawText: undefined,
            costUsd: 0,
            errorMessage: o.error,
          } as AnalyzedRow),
    );
    const successful = results.filter((r) => r.analysis !== null).length;
    const failed = results.length - successful;
    const totalCostUsd = results.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
    console.log(
      `[refresh-makeugc-avatar-index:${trigger}] vision batch attempted=${results.length} ` +
        `successful=${successful} failed=${failed} totalCostUsd=${totalCostUsd.toFixed(4)}`,
    );
    return { attempted: results.length, successful, failed, results };
  });

  // Step E: upsert every successful analysis. Skip rows whose
  // analysis failed — they'll be retried on the next stale cycle
  // (visionAnalyzedAt not bumped so >7d filter still hits).
  const persistedCount = await step.run('persist-batch', async () => {
    let count = 0;
    const db = getDb();
    const now = new Date();
    for (const r of analyzed.results) {
      if (r.analysis === null) continue;
      await db
        .insert(schema.makeugcAvatarIndex)
        .values({
          avatarId: r.avatarId,
          avatarName: r.avatarName,
          thumbnailUrl: r.thumbnailUrl,
          makeugcGender: r.makeugcGender,
          ageBucket: r.analysis.age_bucket,
          ethnicity: r.analysis.ethnicity,
          hairColor: r.analysis.hair_color,
          hairStyle: r.analysis.hair_style,
          facialHair: r.analysis.facial_hair,
          wardrobeStyle: r.analysis.wardrobe_style,
          wardrobeSummary: r.analysis.wardrobe_summary,
          backgroundSetting: r.analysis.background_setting,
          visionAnalysisRaw: r.rawJson as Record<string, unknown> | null,
          visionAnalyzedAt: now,
          lastRefreshedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: schema.makeugcAvatarIndex.avatarId,
          set: {
            avatarName: r.avatarName,
            thumbnailUrl: r.thumbnailUrl,
            makeugcGender: r.makeugcGender,
            ageBucket: r.analysis.age_bucket,
            ethnicity: r.analysis.ethnicity,
            hairColor: r.analysis.hair_color,
            hairStyle: r.analysis.hair_style,
            facialHair: r.analysis.facial_hair,
            wardrobeStyle: r.analysis.wardrobe_style,
            wardrobeSummary: r.analysis.wardrobe_summary,
            backgroundSetting: r.analysis.background_setting,
            visionAnalysisRaw: r.rawJson as Record<string, unknown> | null,
            visionAnalyzedAt: now,
            lastRefreshedAt: now,
            deletedAt: null,
          },
        });
      count++;
    }
    return count;
  });

  // Step F: touch last_refreshed_at on rows that were present +
  // fresh so the stale-scan cursor stays accurate.
  if (diff.toTouchOnlyIds.length > 0) {
    await step.run('touch-fresh-rows', async () => {
      const db = getDb();
      await db
        .update(schema.makeugcAvatarIndex)
        .set({ lastRefreshedAt: new Date() })
        .where(
          and(
            inArray(schema.makeugcAvatarIndex.avatarId, diff.toTouchOnlyIds),
            isNull(schema.makeugcAvatarIndex.deletedAt),
          ),
        );
    });
  }

  // Step G: summary (log + return).
  const totalCostUsd = analyzed.results.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
  const summary = {
    polishVersion: POLISH_VERSION,
    trigger,
    durationMs: Date.now() - startedAt,
    counts: diff.counts,
    analyzeAttempted: analyzed.attempted,
    analyzeSuccessful: analyzed.successful,
    analyzeFailed: analyzed.failed,
    persistedCount,
    totalGeminiCostUsd: Number(totalCostUsd.toFixed(6)),
    staleThresholdMs: STALE_MS,
    forceAll,
    refreshUserId: userId,
  };
  console.log(
    `[refresh-makeugc-avatar-index:${trigger}] cycle complete ${JSON.stringify(summary)}`,
  );
  // sql`` is imported so drizzle-orm's raw-sql tag is available if
  // future ad-hoc queries land here; void it so noUnusedImports
  // strict mode doesn't flag it.
  void sql`select 1`;
  return summary;
}

// ---------------------------------------------------------------
// Polish-25 Commit 8: two SINGLE-trigger functions.
// ---------------------------------------------------------------

export const refreshMakeugcAvatarIndexCron = inngest.createFunction(
  {
    id: 'refresh-makeugc-avatar-index-cron',
    name: 'Polish-25: refresh MakeUGC enriched avatar index (cron)',
    // One function-level retry — internal step.run boundaries own
    // finer-grained recovery. Vision analysis errors are captured
    // per-avatar and never rethrown.
    retries: 1,
  },
  { cron: '0 3 * * *' },
  async ({ step }) => {
    const startedAt = Date.now();
    const userId = await step.run('resolve-refresh-user', async () => {
      // Cron ignores any event.data — always uses env.
      return resolveRefreshUserId(undefined);
    });
    return refreshMakeugcAvatarIndexCore({
      step,
      userId,
      forceAll: false,
      startedAt,
      trigger: 'cron',
    });
  },
);

// Polish-25 Commit 9: Inngest cloud's manifest was stuck on the
// Commit-7 multi-trigger function id `refresh-makeugc-avatar-index`
// even after Commit 8 shipped the -cron / -manual split. PUT-based
// force-sync rejected our deployId formats ("Invalid deploy ID"),
// and Vercel redeploy of the split didn't dislodge the stale entry.
// Pragmatic unstick: keep the BARE-ID function alive (event
// trigger) so the stale manifest routes correctly on the next
// event fire, and let a fresh sync cycle catch up naturally. The
// JavaScript export name stays `refreshMakeugcAvatarIndexManual`
// so functions/index.ts wiring + tests keep working; only the
// Inngest function `id` string changed from `-manual` → bare.
export const refreshMakeugcAvatarIndexManual = inngest.createFunction(
  {
    id: 'refresh-makeugc-avatar-index',
    name: 'Polish-25: refresh MakeUGC enriched avatar index',
    retries: 1,
  },
  { event: 'makeugc/avatar-index.refresh.requested' },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const data = (event?.data ?? {}) as RefreshEventData;
    const forceAll = data.forceAll === true;
    const userId = await step.run('resolve-refresh-user', async () => {
      return resolveRefreshUserId(data.userId);
    });
    return refreshMakeugcAvatarIndexCore({
      step,
      userId,
      forceAll,
      startedAt,
      trigger: 'manual',
    });
  },
);
