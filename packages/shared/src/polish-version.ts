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
 * Polish-27.0.0 (MAJOR bump from 26.0.14) marks the legacy UGC
 * surface nuke — HeyGen / Hedra / WaveSpeed / Replicate / Kie /
 * MakeUGC / ElevenLabs UGC pipelines all rejected on quality;
 * deck cleared for the Polish-28 Seedance 2.5 + Higgsfield Speak v2
 * + ElevenLabs BYOK rebuild.
 */
export const POLISH_VERSION = '28.3.10';

/**
 * Short human-readable slug that pairs with the version for at-a-
 * glance context in the /api/health response. Update alongside
 * POLISH_VERSION when the release ships a materially different fix
 * pattern. Kept intentionally terse post-Polish-27 — the sprawling
 * release notes made this string unreadable and a single stray
 * apostrophe could break the module load; ship-day narratives
 * belong in commit messages, not runtime constants.
 */
export const POLISH_RELEASE_NAME =
  'Polish-28.3.10 Commit 95 - static-ad IMAGE prompt rewritten (Claude copy was already varying fine; images were ugly because the terse edit prompt let gpt-image-2 ghost the source text). New three-step edit prompt: REMOVE old text cleanly, RENDER new headline+body, APPLY per-intensity visual variation while preserving mockup category';

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
