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
export const POLISH_VERSION = '26.0.1';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.1 Commit 61.1 hotfix - HeyGen cost estimator flipped from $1.50/30s to $0.25/30s retail rate. Real: operator cross-checked Commit 61's release note against heygen.com public pricing page and caught a 6x cost overstatement. Root cause: Commit 61 pinned to $0.05/sec (Avatar IV Photo Avatar row from HeyGen's help-center per-engine table at help.heygen.com/en/articles/10060327) which appears to be the DEV-DOCS rate, NOT the public marketing rate. HeyGen's own heygen.com/pricing page shows: Avatar video (standard) $0.50/min = $0.25/30s; Avatar video (extended) $1.00/min = $0.50/30s; Effect video $1.30/video. These two pages don't agree - the discrepancy is real and unexplained by anything visible in current HeyGen surfaces. Verification agent flagged this: 'These two sources DO NOT AGREE.' Fix: (a) estimateHeygenVideoCostUsd in packages/ai-providers/src/heygen-v3-client.ts now uses HEYGEN_USD_PER_SECOND_STANDARD = $0.50/60 = $0.00833/sec; engine + resolution inputs still accepted for API stability but currently ignored (documented via `void` + prominent comment); help-center per-engine constants preserved as HEYGEN_USD_PER_SECOND_*_HELPCENTER for the future true-up; extended tier documented as HEYGEN_USD_PER_SECOND_EXTENDED for reference; (b) cost-estimation.ts polish26_heygen branch mirrors the flip - now quotes $0.25/30s (retail) + $0.02 Claude condenser; (c) generate-polish26-heygen worker's persist-video-url step uses the new estimator + stamps rate_tier='public_pricing_standard' + computed usdPerSecond in generation_jobs.metadata.polish26_heygen_cost so a future true-up can spot invoice drift row-by-row. Prominent comment added at every cost calc site per operator directive: 'HeyGen retail rate. Real cost may vary based on avatar tier returned by API (Avatar IV standard vs V premium). Verify against first HeyGen billing invoice.' True-up protocol documented in estimateHeygenVideoCostUsd() comment: after >=10 live 30-sec generations complete, cross-reference HeyGen dashboard credit consumption vs stamped actualCostUsd; if actual is >30% above displayed, flip to help-center per-engine table AND add tier-forcing to the matcher (currently avatar picker does NOT gate on tier). Regression pin: heygen-v3-client.test.ts updated to lock $0.25/30s default + assert engine/resolution inputs are ignored (prevents a future contributor from silently re-enabling per-tier math without doing the true-up). Version bump: POLISH_VERSION 26.0.0 -> 26.0.1.";

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
