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
export const POLISH_VERSION = '25.8.4';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.8 Commit 51 (part 2 of 2) - AI voice tell sweep across user-facing strings. Mechanical em-dash + AI-phrasing pass across ~50 files: admin surfaces (activity/applications/errors/invites/raw-ugc/test-actions/waitlist), concepts + generate flow, runs/[id] job-review-client (12 sites), /launched page + actions, dashboard + tiles, settings (main + form + rules + acks + billing + heygen + presets + connections), onboarding (agency-bm/keys/risk), meta connection cards, metadata titles, error boundary, pending page, beta banner, command palette, pipeline label formatter. Telegram bot: bot.ts + commands-pause.ts + commands-settings.ts message text. Jobs: telegram-format.ts summary templates. Shared modules: onboarding.ts (dropped 'Please'), settings-form.ts labels, error-translation.ts (kept 'regenerating' string that a test greps for). Empty-cell placeholder swap: typographic '\u2014' \u2192 '-' across ~30 sites in table cells + KPI tiles. One 'We recommend' \u2192 direct imperative. Zero hits on Leverage/Utilize/Facilitate/Prior to and other listed AI-tell phrases (codebase already reads operator-y). Test-dependency accommodations: error-translation PROMINENT_PEOPLE_FILTER 'Try regenerating' kept because packages/shared/tests/error-translation.test.ts:17 asserts /regenerating/i. Did NOT touch: legal content (Commit 50 handled TOS + Privacy), tests, worker pipeline prompts, packages/shared/src/prompts/**, video-models, ai-provider-form, character-lock or omni prompt files, comments, log messages, needles arrays in meta-error-guidance, migrations. Full workspace typecheck green.";

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
