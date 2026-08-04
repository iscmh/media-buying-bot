import { asc, eq } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { apiOk } from '@/lib/api-envelope';
import { withApi } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polish-25.10 Commit 59: GET /api/v1/presets
 *
 * User's saved launch-preset bundles, name-ordered. Consumers
 * apply a preset via the preset_id field on POST /api/v1/launches
 * (TODO: preset_id acceptance in launches — for now, use the
 * fields returned here to populate targeting_countries, age_min,
 * age_max, per_ad_budget_usd, etc.).
 */
export const GET = withApi('presets.list', async (_req, ctx) => {
  const db = getDb();
  const rows = await db.query.userLaunchPresets.findMany({
    where: eq(schema.userLaunchPresets.userId, ctx.userId),
    orderBy: asc(schema.userLaunchPresets.name),
  });
  return apiOk({
    presets: rows.map((r) => ({
      id: r.id,
      name: r.name,
      targeting_countries: r.targetingCountries,
      age_min: r.ageMin,
      age_max: r.ageMax,
      optimization_goal: r.optimizationGoal,
      placement_type: r.placementType,
      per_ad_daily_budget_usd: Number(r.perAdDailyBudgetUsd),
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    })),
  });
});
