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
export const POLISH_VERSION = '25.8.8';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.8 Commit 55 - stuck-generation-job rescue + silent-disable button fix. Bug 1: Eric's two static jobs sat at 'processing' with metadata.static_openai_progress.step=images-rendering pct=55 for 3-7 hours. Root cause: every generation worker only flips generation_jobs.status='failed' from happy-path catch clauses; when the Inngest function itself dies (Vercel 300s ceiling, OOM, network crash between step.run boundaries), no in-function catch runs and status sits at 'processing' indefinitely. Zero generation workers had onFailure hooks (meta-ad-launcher + cleanupErrorLog were the only functions with them from Commit 46/48). Fix: extended packages/jobs/src/error-hook.ts logInngestFailure to also flip generation_jobs.status='failed' when the event carries a jobId (any of jobId / generationJobId / generation_job_id - field name has drifted). Writes 'Worker crashed after retries were exhausted: <message>' + completed_at=now. Attached onFailure: logInngestFailure to all 9 generation workers (generate-polish23-veo-lite, generate-polish25-makeugc, generate-sora-variants, generate-static-image-variants, generate-static-openai-image-variants, generate-static-variants, generate-ugc-variants, generate-video-variant, analyze-concept). Any future function-level crash now flips status + writes error_log row + Sentry event, no more silent stuck jobs. Bug 2: static-form Generate button greyed out with no visible reason. Root cause: apps/web/app/concepts/[id]/generate/simplified-form.tsx disabled={isPending || overCap || !canSubmit || !hasProviderKey} but the visible inline messages only covered overCap + !hasProviderKey - the !canSubmit case (user hadn't picked a model) had only a hover tooltip (invisible on mobile). Fix: added inline paragraph 'Pick a pipeline above (Instant UGC, Static ad, or Higgsfield UGC ad) to enable Generate.' Recovery SQL for the two currently-stuck jobs is embedded in the commit body. Version bump: POLISH_VERSION 25.8.7 -> 25.8.8.";

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
