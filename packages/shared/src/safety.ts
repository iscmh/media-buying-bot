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
