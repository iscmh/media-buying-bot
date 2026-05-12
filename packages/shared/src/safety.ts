/**
 * Hard platform-level spend ceiling per user per day, in USD.
 *
 * Enforced server-side in the settings save action: even if the user enters
 * a higher value into platform_daily_spend_ceiling, we clamp to this. The
 * UI shows the value so users know the cap exists.
 *
 * Bumping requires deliberation — this is the upper bound on how much money
 * a single bot can spend in a day before something has to fail loud. Phase 4
 * spend-safety reads the stricter of (env var, user setting, this constant).
 */
export const PLATFORM_HARD_CEILING_USD = 1000;

/**
 * Phase 3a: hard ceiling on per-day AI generation costs (Gemini/Claude/
 * Kie.ai/HeyGen/Arcads). Same clamping pattern as PLATFORM_HARD_CEILING_USD.
 *
 * Sized at $200/day so a runaway generation job (variant_count typo, retry
 * loop in Phase 3b) can't burn a meaningful amount of the operator's
 * money before the cap stops it. The 100-variant cap per job (enforced
 * separately) reinforces this from the per-job side.
 */
export const PLATFORM_HARD_AI_CEILING_USD = 200;

/** Per-job hard cap on the variant_count field. */
export const MAX_VARIANTS_PER_JOB = 100;

/**
 * Phase 4a: hard ceiling on total per-day Meta launch budget (sum of
 * daily_budget_usd across all ads launched today). Server clamps
 * user_settings.daily_launch_budget_cap_usd to this. Same role as
 * PLATFORM_HARD_CEILING_USD but specifically for the launch-pipeline
 * cap; sized identically since they're enforcing the same underlying
 * "max real-money outlay per day" bound from different angles.
 */
export const PLATFORM_HARD_LAUNCH_CEILING_USD = 1000;

/** Phase 4a: per-ad daily budget hard ceiling. Phase-4b can raise. */
export const PLATFORM_HARD_AD_DAILY_BUDGET_USD = 200;

/**
 * Phase 4a: Meta optimization goals we support at launch time. Values
 * match Meta's Marketing API enum literals exactly so we can pass
 * straight through once BOT_DRY_RUN flips off.
 */
export const META_OPTIMIZATION_GOALS = [
  'CONVERSIONS',
  'LINK_CLICKS',
  'LANDING_PAGE_VIEWS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_SALES',
] as const;
export type MetaOptimizationGoal = (typeof META_OPTIMIZATION_GOALS)[number];

export const META_PLACEMENT_TYPES = ['advantage_plus', 'manual'] as const;
export type MetaPlacementType = (typeof META_PLACEMENT_TYPES)[number];
