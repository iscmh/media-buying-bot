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

  // Step D: analyze thumbnails via Gemini (shared MakeUGC prompt).
  const analyzed = await step.run('analyze-batch', async () => {
    if (diff.toAnalyzeAvatars.length === 0) {
      return { attempted: 0, successful: 0, failed: 0, results: [] };
    }
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) {
        throw new NonRetriableError(
          `refresh-heygen-avatar-index: Gemini BYOK missing for refresh user ${userId}. ` +
            `${err.message}. Vision analysis needs Gemini.`,
        );
      }
      throw err;
    }
    type AnalyzedRow = {
      avatarId: string;
      avatarName: string;
      thumbnailUrl: string;
      heygenGender: string;
      analysis: ReturnType<typeof parseMakeugcAvatarVisionAnalysis>;
      rawJson: unknown;
      costUsd: number;
      errorMessage: string | undefined;
    };
    const outcomes = await runWithConcurrency(
      diff.toAnalyzeAvatars,
      VISION_CONCURRENCY,
      async (avatar): Promise<AnalyzedRow> => {
        if (!avatar.preview_image_url || avatar.preview_image_url.length === 0) {
          return {
            avatarId: avatar.avatar_id,
            avatarName: avatar.avatar_name,
            thumbnailUrl: '',
            heygenGender: avatar.gender ?? '',
            analysis: null,
            rawJson: undefined,
            costUsd: 0,
            errorMessage: 'no preview_image_url — skipped',
          };
        }
        const r = await analyzeMakeugcAvatarThumbnail({
          userId,
          apiKey: keys.gemini!,
          imageUrl: avatar.preview_image_url,
          systemPrompt: MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT,
        });
        const analysis = r.ok ? parseMakeugcAvatarVisionAnalysis(r.parsedJson) : null;
        return {
          avatarId: avatar.avatar_id,
          avatarName: avatar.avatar_name,
          thumbnailUrl: avatar.preview_image_url,
          heygenGender: (avatar.gender ?? '').toLowerCase(),
          analysis,
          rawJson: r.parsedJson,
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
            heygenGender: '',
            analysis: null,
            rawJson: undefined,
            costUsd: 0,
            errorMessage: o.error,
          } as AnalyzedRow),
    );
    const successful = results.filter((r) => r.analysis !== null).length;
    const failed = results.length - successful;
    const totalCostUsd = results.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
    console.log(
      `[refresh-heygen-avatar-index:${trigger}] vision batch attempted=${results.length} ` +
        `successful=${successful} failed=${failed} totalCostUsd=${totalCostUsd.toFixed(4)}`,
    );
    return { attempted: results.length, successful, failed, results };
  });

  // Step E: upsert successful analyses.
  const persistedCount = await step.run('persist-batch', async () => {
    let count = 0;
    const db = getDb();
    const now = new Date();
    for (const r of analyzed.results) {
      if (r.analysis === null) continue;
      await db
        .insert(schema.heygenAvatarIndex)
        .values({
          avatarId: r.avatarId,
          avatarName: r.avatarName,
          thumbnailUrl: r.thumbnailUrl,
          heygenGender: r.heygenGender,
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
          target: schema.heygenAvatarIndex.avatarId,
          set: {
            avatarName: r.avatarName,
            thumbnailUrl: r.thumbnailUrl,
            heygenGender: r.heygenGender,
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
