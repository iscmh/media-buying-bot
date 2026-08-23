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
 * Phase 4b: HARDCODED first-live-launch total-daily-exposure cap.
 * Applies to the user's FIRST live launch session only — once
 * user_settings.live_launch_count > 0, the regular daily launch cap
 * takes over. Sized small enough that a misconfigured ad costs less
 * than dinner if the user forgets to keep status='PAUSED'.
 */
export const FIRST_LIVE_LAUNCH_HARD_CAP_USD = 10;

/**
 * Phase 5: HARDCODED scale-event multiplier ceiling. Even if the user
 * approves a scale, the new daily budget cannot exceed CURRENT × this
 * factor. Prevents a runaway thumb-tap from 10x'ing spend.
 */
export const SCALE_HARD_MULTIPLIER_CAP = 2;

/**
 * Phase 5: HARDCODED first-N-scales increment ceiling. Until a user
 * has user_settings.scale_success_count ≥ this many successful scales,
 * each scale event is capped at +25% regardless of scale_increment_pct.
 */
export const FIRST_SCALES_GRACE_COUNT = 5;
export const FIRST_SCALES_INCREMENT_PCT_CAP = 25;

/**
 * Phase 5: ROAS heuristic constant. We don't yet pull per-conversion
 * `action_values` from Meta /insights (requires Pixel + Conversions API
 * value tracking). Treat every conversion as worth this many USD when
 * computing implied ROAS so the scale rule has a signal. Phase 6 should
 * replace this with the real Meta-reported value.
 */
export const ASSUMED_CONVERSION_VALUE_USD = 20;

/**
 * Phase 7: cap on auto-granted founding-member flags. The first N
 * users get is_founding_member = true at signup; once we hit N the
 * SQL function check_founding_member_eligibility() returns false and
 * later signups are regular users.
 *
 * MUST stay in sync with the `founding_member_cap` constant inside
 * public.check_founding_member_eligibility() (supabase/migrations/
 * 0015_beta_access.sql). They're enforced on different sides; both
 * have to agree.
 */
export const FOUNDING_MEMBER_CAP = 50;

/** Phase 7: default lifetime of a fresh invite code, in days. */
export const INVITE_CODE_DEFAULT_TTL_DAYS = 30;
/** Phase 7: length of a generated invite code (uppercase alphanumeric). */
export const INVITE_CODE_LENGTH = 8;

/**
 * Phase 4a → Polish-28.4.0 Commit 98: Meta optimization goals surfaced
 * in the launch UI. Values match Meta's Marketing API enum literals
 * exactly so we can pass straight through. The full-launch UI exposes
 * these against the campaign objective (each objective admits a subset
 * — SALES → OFFSITE_CONVERSIONS/VALUE, LEADS → LEAD_GENERATION, etc).
 * Kept as a flat union so the ad-set body serializer stays trivial;
 * cross-field validation lives in the frontend + action layer.
 */
export const META_OPTIMIZATION_GOALS = [
  // Traffic
  'LINK_CLICKS',
  'LANDING_PAGE_VIEWS',
  // Sales / conversions
  'OFFSITE_CONVERSIONS',
  'CONVERSIONS',
  'VALUE',
  // Leads
  'LEAD_GENERATION',
  'QUALITY_LEAD',
  // Engagement
  'POST_ENGAGEMENT',
  'PAGE_LIKES',
  'THRUPLAY',
  'VIDEO_VIEWS',
  'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS',
  // Awareness / reach
  'REACH',
  'IMPRESSIONS',
  'AD_RECALL_LIFT',
  // Back-compat outcome-only pseudo-goals (kept so old rows deserialize).
  'OUTCOME_TRAFFIC',
  'OUTCOME_SALES',
] as const;
export type MetaOptimizationGoal = (typeof META_OPTIMIZATION_GOALS)[number];

export const META_PLACEMENT_TYPES = ['advantage_plus', 'manual'] as const;
export type MetaPlacementType = (typeof META_PLACEMENT_TYPES)[number];
