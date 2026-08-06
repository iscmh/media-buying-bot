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
export const POLISH_VERSION = '26.0.9';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.9 Commit 61.9 hotfix - gate Polish-23-era nested-quote validator per pipeline; polish26_heygen opts out. Real evidence: fresh Polish-26 HeyGen generation on concept ddca175b failed with 'Polish-26 condensed-script validation failed [nested-quotes]'. Real: source-video vision analysis contained natural nested-quote pattern (\"we'll see\"); Claude condenser correctly preserved the dialogue verbatim as the Polish-25/26 system prompt instructs. Real: containsQuotedThirdPartySpeech (Polish-23 Commit 3.0.23) was built to defend Google Veo's TTS from nested-quote artifacts - HeyGen's TTS tolerates them fine, real evidence: MakeUGC + HeyGen sample scripts with nested quotes render cleanly on the HeyGen side. Fix (Option A - per-caller gate, cleanest): (a) checkPolish25CondensedScript in packages/jobs/src/lib/polish25-claude-script-condenser-prompt.ts now takes a Polish25ScriptCheckOptions second arg with { skipNestedQuotes?: boolean } - default false preserves the Polish-25 MakeUGC behavior. (b) polish26_heygen worker call site (packages/jobs/src/functions/generate-polish26-heygen.ts line ~354) now passes { skipNestedQuotes: true } - narrow, explicit, self-documented at the call site. (c) All other checks (empty, too-long, appearance-leak) apply UNCONDITIONALLY regardless of the flag - the appearance-leak invariant especially cannot be weakened because the pre-cast avatar visualizes appearance so the script must never describe it, HeyGen or otherwise. Regression pin: packages/jobs/tests/polish25-script-check-gate.test.ts +9 assertions: default (no options) still rejects nested quotes; explicit {} still rejects; skipNestedQuotes:false still rejects; skipNestedQuotes:true accepts nested quotes; skipNestedQuotes:true still rejects empty / too-long / appearance-leak; clean scripts pass in both modes. Do-not-touched: HeyGen client, sync worker, Meta launcher, static pipelines, polish25 MakeUGC worker (still rejects nested quotes by default), Polish-23 Veo worker, Zod schema Polish25CondensedScriptSchema (leave rejecting nested quotes - only the imperative check gained the option). Version bump: POLISH_VERSION 26.0.8 -> 26.0.9.";

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
