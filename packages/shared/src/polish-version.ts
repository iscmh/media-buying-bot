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
export const POLISH_VERSION = '25.8.5';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.8 Commit 52 - jargon leak sweep + regression tripwire. Operator flagged 'Polish-XX' + 'MakeUGC' still surfacing on provider cards + cost line-items despite Commit 40's sweep. Fixed 5 user-visible leaks in shared/src: ai-provider-form.ts (elevenlabs description dropped 'Polish-22' reference, wavespeed_ai description dropped 'Polish-23' reference, makeugc card label 'MakeUGC' -> 'Instant UGC', makeugc description dropped 'Polish-25 pivot after Polish-24' history, key-hint text 'MakeUGC keys' -> 'Instant UGC keys') + cost-estimation.ts (line-item label 'MakeUGC pre-cast avatar video' -> 'Instant UGC pre-cast avatar video'). New regression tripwire packages/shared/tests/no-jargon-leaks.test.ts walks every packages/shared/src/**/*.ts, extracts string literals (double / single / template), strips ${} interpolations + code comments, matches against jargon patterns (Polish-XX version markers, Commit XX references, MakeUGC brand, polish25_/polish23_ enum leaks, raw makeugc/wavespeed_ai/gemini_nano_banana enum leaks). Zero-tolerance: any hit fails CI with the file + string snippet + fix guidance. Allowlist covers internal-identifier files (polish-version, pipeline-descriptors, types, prompt fragments, kie-omni-prompt, video-models, cost-estimation switch cases, index.ts barrel, ai-provider-form enum keys). Future edit that reintroduces jargon in a user-facing string fails the build before it can ship. Zero remaining leaks in in-scope files.";

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
