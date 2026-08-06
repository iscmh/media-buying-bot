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
export const POLISH_VERSION = '26.0.4';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.4 Commit 61.4 hotfix - HeyGen avatar sync hit Vercel Hobby 60s FUNCTION_INVOCATION_TIMEOUT after Gemini prepay credits resolved billing. Root cause: analyze-batch step processed all 1264 HeyGen avatars in ONE step.run at concurrency 5 (~8-10 min wall-clock); Vercel Hobby caps each HTTP invocation at 60 seconds; timeout fired before any output produced. Request ID 6789b-1785995821609-9b7bb373bed1, region iad1. Fix: chunk the analyze-batch step into N step.run('analyze-persist-chunk-K') calls of HEYGEN_ANALYZE_CHUNK_SIZE avatars each (default 12, env-overridable to 100 for Vercel Pro's 300s ceiling). Each chunk is its own HTTP invocation so no single one risks the 60s cap; Inngest orchestrates ~106 sequential invocations for a full 1264-avatar sync. Persistence moved INSIDE each chunk (no separate persist-batch step) so partial progress survives mid-sync failure - already-analyzed avatars stay in heygen_avatar_index and next cycle's stale-scan skips them. Circuit breaker (Commit-61.2's >=20 consecutive same-signature failures) preserved and ENFORCED ACROSS CHUNKS using deterministic cumulative state reconstructed from Inngest's cached step.run results on replay: outer loop tracks cumConsecutiveFailures + cumLastSignature, iterating over each chunk's compact resultSigs array. Cross-chunk streak that spans chunk 3 → chunk 4 counts as one streak. Preflight step (analyze-preflight-gemini-key) added to fail loud on missing Gemini BYOK BEFORE scheduling per-chunk work. Per-chunk progress log: '[refresh-heygen-avatar-index:manual] chunk 3/106: attempted=12 successful=12 failed=0 persisted=12 costUsd=0.0060'. Summary extended: chunkSize + totalChunks + earlyExitAtChunk (when circuit-breaker trips). New exports: resolveHeygenAnalyzeChunkSize(), chunkArray(), errorSignature() - all with regression tests. Regression pin: chunk-array.test.ts +9 assertions locking chunk size defaults, env-override behavior, chunk boundary correctness, error-signature fingerprint normalization. Do-not-touched: MakeUGC pipeline (180 avatars fits under 60s single-step), HeyGen client (fetch/submit/poll), other workers, prompt files, Meta launcher. Version bump: POLISH_VERSION 26.0.3 -> 26.0.4.";

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
