/**
 * Versioned ToS. Bumping this constant forces every existing user back through
 * /onboarding/tos on next page load — page-level gating compares
 * users.tos_version against this. The matching DB row is written when the
 * user accepts.
 *
 * Rule: bump on any user-visible content change. Use ISO date suffixed with
 * a letter if multiple revisions land on the same day (e.g. 2025-05-01b).
 */
export const TOS_VERSION = '2025-05-01';
