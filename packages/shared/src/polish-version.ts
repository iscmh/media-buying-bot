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
export const POLISH_VERSION = '25.9.1';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.9 Commit 58 - OpenAI billing/quota/key error classifier. Tester hit 'NonRetriableError: Billing hard limit has been reached.' on static generation job e0d477ff; job sat 5 min before Commit 55's onFailure hook flipped it. Root cause: the worker's typed-error catch (OpenaiInsufficientFundsError etc.) stashed err.message unchanged into generation_metadata.error, then rethrew NonRetriableError(err.message). The tester saw the raw Google/OpenAI string with zero next-step guidance. Fix: new classifyOpenaiErrorMessage() + describeOpenaiError() helpers in packages/ai-providers/src/openai-image-client.ts. Eight buckets: billing_limit (Cloud Console limits URL), quota_exceeded (billing page URL), invalid_key (api-keys URL), rate_limit (wait + retry hint), content_policy (regenerate hint), invalid_image (format hint), timeout (retry hint), other (pass-through generic hint). Named 'Message' variant to avoid collision with the internal classifyOpenaiError() that takes a structured HTTP response payload. Applied at the single call site in generate-static-openai-image-variants.ts NonRetriable catch - now writes describeOpenaiError(err.message) to generation_metadata.error + keeps err.message under error_raw for grep, then throws NonRetriableError(described) so the operator sees the actionable string in the Inngest UI too. Regression pin: packages/ai-providers/tests/openai-error-classifier.test.ts (9 assertions) locks tester's exact 'Billing hard limit' string to billing_limit + asserts each bucket surfaces the right URL. Version bump: POLISH_VERSION 25.9.0 -> 25.9.1.";

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
