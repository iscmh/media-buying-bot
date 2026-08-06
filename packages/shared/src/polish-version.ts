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
export const POLISH_VERSION = '26.0.5';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.5 Commit 61.5 - user-facing Instant UGC card rebound to polish26_heygen backend. Real evidence: after Commit 61.4 successfully indexed 422 HeyGen avatars, operator noticed /concepts/[id]/generate still dispatched polish25_makeugc when the 'Instant UGC ad' card was clicked - polish26_heygen worker had never been wired to the user-facing form. Commit 61's spec item D was deferred/partially implemented; card copy still said 'You only pay Claude + Gemini token usage' (MakeUGC-era, wrong for HeyGen per-second billing). Firing this would have routed to MakeUGC (currently 0 credits until Aug 9) = guaranteed fail. Fix: add POLISH26_PIPELINE_ID + POLISH26_DISPLAY_NAME + POLISH26_DESCRIPTION + estimatePolish26CostPerVariantUsd() to simplified-form-helpers.ts. Add polish26Selected optional field to SimplifiedFormState (keep polish25Selected in the type for API back-compat). Update canSubmitState + buildSubmissionFormData: polish26 branch checked BEFORE polish25 so a form that somehow sets both defaults to HeyGen. Rebind simplified-form.tsx: rename state polish25Selected -> polish26Selected throughout (12+ references), swap POLISH25_* imports to POLISH26_*, rename Polish25PickerCard -> Polish26PickerCard, wire cost preview through estimatePolish26CostPerVariantUsd(detectedSourceSeconds) so per-second billing scales the line with the uploaded source length. Card copy now says 'Pre-cast avatar picked from a 500+ HeyGen library... Standard tier at HeyGen retail ($0.50/min = $0.25 per 30-second video)'. polish25_makeugc still dispatchable via POST /api/v1/generations with pipeline=polish25_makeugc explicitly - descriptor + worker + refresh cron all still registered. Regression pin: apps/web/app/concepts/[id]/generate/__tests__/polish26-dispatch.test.ts +9 assertions covering: polish26Selected dispatches pipeline=polish26_heygen, polish26 takes precedence over polish25 when both set (defense-in-depth), polish25Selected alone still dispatches polish25_makeugc (API back-compat), POLISH26_DISPLAY_NAME keeps user-visible 'Instant UGC ad' string, cost preview $0.27 at 30s default, linear scaling with sourceDurationSeconds ($0.52 at 60s, $0.145 at 15s, $1.02 at 120s), non-positive durations fall back to 30s default. Do-not-touched: HeyGen client, HeyGen sync worker, static generation, Meta launcher. Version bump: POLISH_VERSION 26.0.4 -> 26.0.5.";

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
