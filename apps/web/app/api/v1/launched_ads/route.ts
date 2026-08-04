import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@mbb/db';
import { apiError, apiOk } from '@/lib/api-envelope';
import { withApi } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ListLaunchedAdsQuery = z.object({
  status: z
    .enum(['dry_run', 'active', 'paused', 'killed', 'rejected_by_meta', 'launch_failed'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Polish-25.10 Commit 59: GET /api/v1/launched_ads
 *
 * Returns real ROAS + spend/impressions/clicks/conversions from Meta
 * (as of the last poll — current_* columns).
 */
export const GET = withApi('launched_ads.list', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = ListLaunchedAdsQuery.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!parsed.success) {
    return apiError(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid query parameters.',
    );
  }
  const { status, limit, offset } = parsed.data;
  const db = getDb();
  const rows = await db.query.launchedAds.findMany({
    where: status
      ? and(eq(schema.launchedAds.userId, ctx.userId), eq(schema.launchedAds.status, status))
      : eq(schema.launchedAds.userId, ctx.userId),
    orderBy: desc(schema.launchedAds.launchedAt),
    limit,
    offset,
  });
  return apiOk({
    limit,
    offset,
    launched_ads: rows.map((r) => ({
      id: r.id,
      generation_id: r.generationJobId,
      generated_creative_id: r.generatedCreativeId,
      concept_id: r.conceptId,
      meta_ad_id: r.metaAdId,
      meta_ad_set_id: r.metaAdSetId,
      meta_campaign_id: r.metaCampaignId,
      status: r.status,
      mode: r.mode,
      daily_budget_usd: Number(r.dailyBudgetUsd),
      optimization_goal: r.optimizationGoal,
      placement_type: r.placementType,
      current_spend: r.currentSpend != null ? Number(r.currentSpend) : null,
      current_impressions: r.currentImpressions,
      current_clicks: r.currentClicks,
      current_conversions: r.currentConversions,
      current_ctr: r.currentCtr != null ? Number(r.currentCtr) : null,
      current_cpc: r.currentCpc != null ? Number(r.currentCpc) : null,
      conversion_value_usd: Number(r.conversionValueUsd),
      kill_recommended_at: r.killRecommendedAt?.toISOString() ?? null,
      kill_recommended_reason: r.killRecommendedReason,
      scale_recommended_at: r.scaleRecommendedAt?.toISOString() ?? null,
      scale_recommended_to_usd:
        r.scaleRecommendedToUsd != null ? Number(r.scaleRecommendedToUsd) : null,
      launched_at: r.launchedAt.toISOString(),
      paused_at: r.pausedAt?.toISOString() ?? null,
      killed_at: r.killedAt?.toISOString() ?? null,
      last_polled_at: r.lastPolledAt?.toISOString() ?? null,
    })),
  });
});
