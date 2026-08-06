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
export const POLISH_VERSION = '26.0.2';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.2 Commit 61.2 hotfix - HeyGen avatar sync 100% failing on Gemini vision step, root-cause blind. Real evidence: Inngest run 01KZAPKYZ03W6DA9ZE8D918BHY hit 1264 attempted / 1264 failed / 0 successful; retry got identical 1264/1264/0 pattern; every avatar returned opaque 'Google GenAI API 500 Internal error encountered'; totalGeminiCostUsd=$0 (Gemini rejected before charging); MakeUGC sync still healthy on same Gemini key + prompt. Root-cause hypothesis: HeyGen preview_image_url may return animated WebP / video-container / other content-type Gemini's inline_data decoder rejects — Commit 61's 'analyzer is provider-agnostic' assumption was wrong for this failure mode. Verification impossible from this env (Cloudflare 403 on every HeyGen URL) so fix is defensive rather than surgical - unblocks operator to see the ACTUAL cause on the next cycle. Fix: (a) analyzeMakeugcAvatarThumbnail in packages/ai-providers/src/gemini-client.ts now returns rich AnalyzeMakeugcAvatarThumbnailResult.diagnostics { imageMime, imageBytes, imageFetchStatus, geminiStatus, geminiRawBodyExcerpt, failedAt } on failure - MakeUGC refresh worker ignores this backward-compatibly, HeyGen refresh worker consumes it; (b) new isGeminiInlineImageMimeSupported() MIME allowlist (PNG/JPEG/WebP/HEIC/HEIF per REST v1beta docs) rejects unsupported content-types BEFORE the Gemini call with a clear 'Refusing to send unsupported MIME type X' error + failedAt='mime-filter' diagnostic - stops burning quota on guaranteed rejects; (c) analyzer now packs Gemini's raw response body excerpt (2 KB) into the returned errorMessage on non-2xx so callers see the actual rejection payload instead of an opaque HTTP status; (d) refresh-heygen-avatar-index worker's analyze-batch step captures FIRST failure with full diagnostic dump (avatar_id + preview_url + error + diagnostics blob) logged to Vercel Runtime Logs immediately so operator has one place to read the actual cause; (e) circuit-breaker early-exit after 20 consecutive same-signature failures - fingerprints error message (digits normalized) and halts batch with actionable summary instead of burning 20 min proving 1000 more identical failures; (f) earlyExit + firstFailure surfaced in Inngest run summary JSON so it lands in the Runs list view. Regression pin: heygen-v3-client.test.ts +12 assertions locking the MIME allowlist (accepts PNG/JPEG/WebP/HEIC/HEIF + case-insensitive + parameter-suffix normalization, rejects GIF/SVG/AVIF/video/octet-stream/null/empty). Do-not-touched: MakeUGC pipeline (working fine), HeyGen submit/status/poll code, other pipelines. Version bump: POLISH_VERSION 26.0.1 -> 26.0.2.";

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
