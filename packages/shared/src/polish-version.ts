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
export const POLISH_VERSION = '26.0.3';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.3 Commit 61.3 hotfix - HeyGen CDN mis-serves WebP as binary/octet-stream, Commit-61.2's diagnostics unblocked the real cause. Operator confirmed evidence: URL https://files2.heygen.ai/avatar/v3/1ad51ab9fee24ae88af067206e14a1d8_44250/preview_target.webp; Content-Type 'binary/octet-stream'; HTTP 200; 39096 bytes; body is a real WebP that Gemini would accept if we told it image/webp. Commit-61.2's naive MIME allowlist correctly rejected the generic content-type but left 100% of HeyGen avatars unindexable. Fix: two-step MIME inference (new resolveInlineImageMime() helper in gemini-client.ts). (a) If the header is ALREADY a supported image type (image/png|jpeg|webp|heic|heif), keep it. (b) If it's generic (binary/octet-stream, application/octet-stream, application/binary, application/unknown, text/plain, or empty), try URL-extension → MIME (.webp→image/webp, .png→image/png, etc.) with query/fragment stripping. (c) If that fails, try magic-byte detection (PNG=89 50 4E 47…, JPEG=FF D8 FF, WebP=RIFF????WEBP, HEIC/HEIF=…ftypheic|ftypmif1) as belt-and-suspenders for signed URLs with no extension. (d) If NONE of the above yields a supported image type, still reject — deliberately DO NOT fight a wrong-but-specific header (e.g. 'video/mp4') because that would route real garbage to Gemini and reproduce the exact 500 we're preventing. Diagnostics extended: AnalyzeMakeugcAvatarThumbnailResult.diagnostics now carries mimeInferred (true when override happened), mimeInferredFrom ('url-extension' | 'magic-bytes'), mimeSentToGemini (the final MIME) on every success/failure path so operator forensics catch CDN mis-serving. Prominent [gemini-vision] log line emitted whenever inference fires with the before/after MIME + URL. Backward-compat: MakeUGC refresh worker ignores the new fields (Polish-25 pipeline still healthy); resolveInlineImageMime + isGeminiInlineImageMimeSupported both exported from @mbb/ai-providers barrel. Regression pin: heygen-v3-client.test.ts +11 assertions covering: happy-path passthrough, parameter-suffix normalization, HeyGen .webp+binary/octet-stream → image/webp, .png+application/octet-stream → image/png, .jpg+.jpeg both variants, query/fragment stripping, magic-byte detection when no extension (PNG/JPEG/WebP), null-return when both paths fail, refusal-to-fight-wrong-but-specific-header (video/mp4 stays rejected), .gif rejection under generic header, text/plain + empty + undefined all treated as generic-needs-inference. Do-not-touched: MakeUGC pipeline, HeyGen submit/status/poll code, other pipelines. Version bump: POLISH_VERSION 26.0.2 -> 26.0.3.";

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
