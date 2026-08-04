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
export const POLISH_VERSION = '25.8.7';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.8 Commit 54 - Gemini Files upload error classifier + actionable hints. Tester hit 'Gemini Files upload failed: Your project has been denied access. Please contact support.. Try compressing the video under 100 MB.' Root cause: the user's BYOK Gemini API key's Google Cloud project lacks the Generative Language API enabled. The 'try compressing' suffix from the pre-Commit-54 error message was actively misleading - it sent the tester chasing a file-size issue when the real fix is a one-click Cloud Console enablement on the project the API key belongs to. Fix: new classifyGeminiUploadError() + describeGeminiUploadError() helpers in packages/ai-providers/src/gemini-client.ts. Four buckets: denied_access (PERMISSION_DENIED / 'denied access' / 'please contact support' / 'not authorized' - surfaces the Cloud Console enablement URL), quota (429 / RESOURCE_EXHAUSTED / 'rate limit' / 'quota' - surfaces the quotas page URL), too_large (413 / 'too large' / 'exceeds' / 'payload too large' - the ONLY category where compressing helps), other (pass-through with generic 'contact Google support' hint). Preserves the raw Google error text for greppability. Applied at the single call site in callGeminiVisionViaFiles. Pin test packages/ai-providers/tests/gemini-upload-error.test.ts (6 assertions) locks the exact tester's error string to the denied_access bucket + asserts no 'compress' word appears in denied_access advice - a future regex tweak that misroutes it fails CI. Version bump: POLISH_VERSION 25.8.6 -> 25.8.7.";

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
