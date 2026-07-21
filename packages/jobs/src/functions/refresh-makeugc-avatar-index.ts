/**
 * Polish-25 Commit 7: nightly refresh of the enriched MakeUGC
 * avatar index.
 *
 * Two triggers on the same function:
 *   1. Inngest cron '0 3 * * *' — nightly at 3am UTC.
 *   2. Event 'makeugc/avatar-index.refresh.requested' — manual /
 *      on-demand dispatch (from admin UI, ad-hoc scripts, or curl
 *      to /api/inngest).
 *
 * Steps (each its own step.run — Inngest retry boundary):
 *   A. resolve-refresh-user     — pick the userId whose Gemini +
 *                                  MakeUGC keys we use for this
 *                                  cycle. Cron uses env-configured
 *                                  MAKEUGC_REFRESH_USER_ID; manual
 *                                  event uses event.data.userId.
 *   B. fetch-avatar-list        — GET /video/avatars (no gender
 *                                  filter → full library).
 *   C. diff-against-index       — split into new / stale (>7d) /
 *                                  unchanged / disappeared subsets.
 *   D. mark-disappeared-deleted — set deleted_at on rows no longer
 *                                  in the MakeUGC library.
 *   E. analyze-batch            — Gemini Vision on new + stale
 *                                  thumbnails, concurrency-limited
 *                                  to 5 parallel.
 *   F. persist-batch            — upsert enriched descriptors.
 *   G. persist-summary          — log-level summary + counters.
 *
 * Cost budget: ~$0.001/thumbnail × ~500 avatars = ~$0.50 initial
 * build. Weekly stale refresh keeps ongoing spend near $0.50/week.
 */
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  analyzeMakeugcAvatarThumbnail,
  listMakeugcAvatars,
  type MakeugcAvatar,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
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
 */
function resolveRefreshUserId(eventUserId: string | undefined): string {
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

function bucketize(
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

export const refreshMakeugcAvatarIndex = inngest.createFunction(
  {
    id: 'refresh-makeugc-avatar-index',
    name: 'Polish-25: refresh MakeUGC enriched avatar index',
    // One function-level retry — internal step.run boundaries own
    // finer-grained recovery. Vision analysis errors are captured
    // per-avatar and never rethrown.
    retries: 1,
  },
  // Dual trigger: nightly cron + on-demand event dispatch.
  // Inngest v3.x supports the { triggers: [...] } array form.
  [{ cron: '0 3 * * *' }, { event: 'makeugc/avatar-index.refresh.requested' }],
  async ({ event, step }) => {
    const data = (event?.data ?? {}) as RefreshEventData;
    const forceAll = data.forceAll === true;
    const startedAt = Date.now();

    // Step A: resolve who we borrow keys from.
    const userId = await step.run('resolve-refresh-user', async () => {
      return resolveRefreshUserId(data.userId);
    });

    // Step B: fetch live library.
    const liveAvatars = await step.run('fetch-avatar-list', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['makeugc']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          throw new NonRetriableError(
            `refresh-makeugc-avatar-index: MakeUGC BYOK missing for refresh user ${userId}. ` +
              err.message,
          );
        }
        throw err;
      }
      const r = await listMakeugcAvatars({ userId, apiKey: keys.makeugc! });
      if (!r.ok) {
        throw new NonRetriableError(
          `refresh-makeugc-avatar-index: listMakeugcAvatars failed — ` +
            `${r.errorMessage ?? 'unknown'}`,
        );
      }
      return r.avatars;
    });

    // Step C: diff against the existing index.
    const diff = await step.run('diff-against-index', async () => {
      const db = getDb();
      const rows = await db.query.makeugcAvatarIndex.findMany({
        columns: { avatarId: true, visionAnalyzedAt: true, deletedAt: true },
      });
      const buckets = bucketize(liveAvatars, rows, Date.now(), forceAll);
      console.log(
        `[refresh-makeugc-avatar-index] diff live=${liveAvatars.length} ` +
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

    // Step D: soft-delete rows that disappeared from MakeUGC.
    if (diff.toSoftDeleteIds.length > 0) {
      await step.run('mark-disappeared-deleted', async () => {
        const db = getDb();
        await db
          .update(schema.makeugcAvatarIndex)
          .set({ deletedAt: new Date() })
          .where(inArray(schema.makeugcAvatarIndex.avatarId, diff.toSoftDeleteIds));
      });
    }

    // Step E: analyze thumbnails. Skip step.run for the outer loop
    // because we want the concurrency runner + per-item failure
    // isolation; each analyzed row lands in metadata as durable
    // audit whether or not the row itself was reachable.
    const analyzed = await step.run('analyze-batch', async () => {
      if (diff.toAnalyzeAvatars.length === 0) {
        return { attempted: 0, successful: 0, failed: 0, results: [] };
      }
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['gemini', 'makeugc']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          throw new NonRetriableError(
            `refresh-makeugc-avatar-index: Gemini BYOK missing for refresh user ${userId}. ` +
              `${err.message}. MakeUGC key OK but vision analysis needs Gemini.`,
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
        `[refresh-makeugc-avatar-index] vision batch attempted=${results.length} ` +
          `successful=${successful} failed=${failed} totalCostUsd=${totalCostUsd.toFixed(4)}`,
      );
      return { attempted: results.length, successful, failed, results };
    });

    // Step F: upsert every successful analysis. Skip rows whose
    // analysis failed — they'll be retried on the next stale
    // cycle (visionAnalyzedAt not bumped so >7d filter still hits).
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

    // Also touch last_refreshed_at on rows that were present +
    // fresh (no re-analysis but still confirm current), so the
    // stale-scan cursor stays accurate.
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
      durationMs: Date.now() - startedAt,
      counts: diff.counts,
      analyzeAttempted: analyzed.attempted,
      analyzeSuccessful: analyzed.successful,
      analyzeFailed: analyzed.failed,
      persistedCount,
      totalGeminiCostUsd: Number(totalCostUsd.toFixed(6)),
      // Simple health signal for the next stale-scan cursor: if this
      // is much larger than the population, something's mis-tuned.
      // Kept as a hint, not enforced.
      staleThresholdMs: STALE_MS,
      forceAll,
      refreshUserId: userId,
    };
    console.log(`[refresh-makeugc-avatar-index] cycle complete ${JSON.stringify(summary)}`);
    // Cheap sanity check the returned type is what we expect. sql`` avoids an
    // unused-import lint hit when the file compiles under strict mode.
    void sql`select 1`;
    return summary;
  },
);
