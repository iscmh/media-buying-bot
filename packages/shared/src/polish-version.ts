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
export const POLISH_VERSION = '25.8.9';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.8 Commit 56 - orphan static_gemini_image creative rows + wrong-worker dispatch. Real data anomaly: creative 9c9a0794 with format=static_gemini_image + status=rejected + empty file_url + null image_storage_path attached to job f13f64c6 which is a completed polish25_makeugc (UGC video) job. Root cause: legacy fan-out path (apps/web/lib/inngest/send.ts:62) still dispatches generation/static.requested against static-typed concepts; a race or retry earlier fired that against a job that ended up running through the polish25 path, producing an orphan static_gemini_image row when Gemini image gen hit a 'denied access' failure (project missing Generative Language API enablement). Three defensive fixes: (1) apps/web/app/runs/[id]/page.tsx filters out orphan rows before render \u2014 status=rejected + no fileUrl + no image_storage_path AND format-prefix mismatches the job's format. Genuine per-variant rejections inside the correct pipeline still show. (2) generate-static-variants.ts pipeline guard at the top of the worker refuses to run if the job's format / picked_pipeline doesn't map to a static-gemini pipeline. Logs an audit event 'generation_job_dispatch_refused' with reason=format_mismatch instead of writing an orphan row. Any future misroute short-circuits with a clean audit trail. (3) generate-static-variants.ts now runs Gemini image errors through the Commit 54 describeGeminiUploadError classifier so denied_access / quota / too_large surface the same actionable guidance (Cloud Console URL for API enablement) that the Files upload path shows. Exported classifyGeminiUploadError + describeGeminiUploadError + DEFAULT_GEMINI_VISION_MODEL from the ai-providers barrel. Recovery SQL for existing orphan rows embedded in commit body. Version bump: POLISH_VERSION 25.8.8 -> 25.8.9.";

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
