/**
 * Polish-21.0.15: single source of truth for the shipped Polish
 * version. Imported by:
 *
 *   - packages/jobs (worker → composite-row metadata + cold-start log)
 *   - apps/web `/api/health` (curl-verifiable freshness endpoint)
 *   - apps/web `/api/version` (dedicated version endpoint)
 *
 * A shared constant creates a cross-package import chain that MUST
 * rebuild every downstream when this file changes — no more "did
 * Vercel actually pick up the packages/jobs change?" guessing.
 *
 * ---------------------------------------------------------------
 * WHY THIS EXISTS — Polish-21.0.15 root-cause diagnostic
 * ---------------------------------------------------------------
 * Job 961281c5 showed `polish_version: null` on a failed RETRY
 * even though Vercel dashboard confirmed the Polish-21.0.14 SHA
 * (1065775) as deployed. Root cause was likely Inngest's
 * documented behavior: retries of an IN-FLIGHT job execute
 * against the function version that was live when the job was
 * FIRST invoked — not the currently-deployed version. So a job
 * originally submitted pre-Polish-21.0.14 keeps running the old
 * code on every retry.
 *
 * Diagnosis protocol for a "did the deploy stick?" report:
 *   1. Curl `/api/health` — reports POLISH_VERSION. If the value
 *      isn't the SHA-in-question, the deploy legitimately didn't
 *      stick (rare — check Vercel build logs).
 *   2. If /api/health shows the expected version but composite
 *      rows still say polish_version=null, submit a NEW job (not
 *      a retry). Inngest's frozen-version-per-job behavior means
 *      retries never see new code.
 *   3. To force an in-flight job onto the new code: cancel it in
 *      the Inngest dashboard and re-invoke — Inngest treats that
 *      as a new submission and picks up the current function
 *      version.
 */

/**
 * Bumped on every Polish release. Format: MAJOR.MINOR.PATCH.
 * Change here → next `pnpm build` cascades through @mbb/jobs +
 * apps/web (both `transpilePackages`-linked to @mbb/shared).
 *
 * Polish-25.1 (MINOR bump from 25.0.x) marks the UX-layer overhaul
 * shipping in Commit 10a + 10b. The pipeline / worker / BYOK
 * plumbing (Commits 1-9) is untouched; only the presentation +
 * information-architecture layer changes.
 */
export const POLISH_VERSION = '26.0.7';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.7 Commit 61.7 hotfix - HeyGen avatar matcher filtered to launch-ready backgrounds only. Real evidence: operator's first HeyGen generation matched an obviously-AI neutral-background avatar. heygen_avatar_index distribution across 422 active avatars: neutral 233 (white/plain, reads obviously AI-generated), indoor_home 76 (real UGC vibe), indoor_office 44 (mixed), studio 45 (obviously fake staged), outdoor 21 (most convincing), other 3. Pre-fix the matcher pulled uniformly from all 422 — over half were quality-disqualified. Fix: fallback-ladder background filter in generate-polish26-heygen.ts. TIER 1 (primary) reads HEYGEN_BACKGROUND_ALLOWLIST env, default 'indoor_home,outdoor' → 97 launch-ready candidates. TIER 2 (fallback) auto-adds 'indoor_office' when the primary + gender + persona filter leaves an empty pool → 141 candidates. TIER 3 (last-resort) adds 'neutral' + 'studio' + 'other' only when HEYGEN_ALLOW_NEUTRAL_BACKGROUNDS='true'|'1'|'yes' explicitly set — never on by default. Query pushes down via drizzle inArray() on background_setting so we only pull matching rows into memory. Match metadata extended: backgroundTier ('primary'|'fallback'|'last-resort') + winnerBackground stamped into generation_jobs.metadata.polish26_avatar_match so any quality regression is grep-pable via SQL. Loud [polish-26-worker] logs: candidate count per tier + escalation warnings + final pool size. Two new exports: resolveHeygenBackgroundAllowlist() + heygenAllowNeutralBackgrounds() — both with regression tests. Regression pin: heygen-background-allowlist.test.ts +12 assertions covering: default allowlist ['indoor_home','outdoor'] when env unset, comma-parse override, lowercase/trim, whitespace-only env falls back to default, neutral opt-in defaults false (THE quality gate), true/TRUE/1/yes all opt in, ambiguous strings (maybe/0/off/no/false) stay opted out. Do-not-touched: HeyGen client, sync worker (still populates all avatars — filter is read-side), Meta launcher, static pipelines, MakeUGC worker. Version bump: POLISH_VERSION 26.0.6 -> 26.0.7.";

/**
 * Frozen at module-load time so cold-start diagnostics have a
 * stable value even if a caller mutates process.env mid-execution.
 * Consumed by /api/health for release-SHA reporting when the
 * platform sets VERCEL_GIT_COMMIT_SHA (Vercel does by default).
 */
export const POLISH_RELEASE_SHA: string =
  process.env['VERCEL_GIT_COMMIT_SHA'] ??
  process.env['GIT_COMMIT_SHA'] ??
  '(unknown — set VERCEL_GIT_COMMIT_SHA or GIT_COMMIT_SHA)';
