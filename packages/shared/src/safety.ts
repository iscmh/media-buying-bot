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
