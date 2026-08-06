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
export const POLISH_VERSION = '26.0.0';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0 Commit 61 - HeyGen v3 becomes primary managed Instant UGC backend (replaces MakeUGC). Real: MakeUGC's $0.05/video was undercutting Ads Bot economics on a different axis (fixed pool commitment + low quality ceiling); HeyGen v3 PAYG bills per-second on Avatar V ($0.05/sec = $1.50 per 30-sec video) with a 500+ pre-cast avatar library and first-class webhook + moderation policy. Operator explicitly accepted PAYG list pricing over negotiated Scale-tier rate (aggressive-buyer volume risk documented but shipped anyway). Coexist track - NEW packages/ai-providers/src/heygen-v3-client.ts (types + typed errors + cost helpers + list/submit/status + enriched matcher, ~600 LoC) lives alongside legacy Polish-24 heygen-client.ts + heygen.ts + generate-ugc-variants.ts which stay untouched for BYOK users. Ships: (a) migration 0045_heygen_avatar_index.sql + Drizzle schema (mirror MakeUGC's 0037 shape - same Gemini vision enum values so the vision prompt is reused verbatim); (b) resolveHeygenManagedKey helper (env-first HEYGEN_MANAGED_KEY, BYOK fallback via existing loadDecryptedKeys[heygen]); (c) generate-polish26-heygen worker on generation/polish26-heygen.requested (byte-for-byte mirror of generate-polish25-makeugc.ts orchestration: load-job A -> mark-processing B -> load-concept-source-context C -> persist-source-context D -> claude-script-condense E (reuses POLISH25_CLAUDE_SCRIPT_CONDENSER prompt) -> persist-script F -> heygen-avatar-match G (enriched-index primary + gender-only live-listing fallback + persist match log) -> heygen-submit-with-retry H (2 retries + 15s backoff on transient) -> poll-loop I (60 attempts * 10s = 10-min cap, HeyGen renders in 2-5min typical) -> persist-video-url J (hotlink CDN URL with 7-day expiry caveat; storage mirror deferred to Commit 62) -> markJobCompleted K); (d) refresh-heygen-avatar-index cron + manual functions (mirror MakeUGC refresh pattern, 04:00 UTC cron 1h after MakeUGC to stagger Gemini load, reuses analyzeMakeugcAvatarThumbnail + MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT verbatim); (e) pipeline-descriptors.ts new polish26_heygen descriptor (workerEvent generation/polish26-heygen.requested, format polish26_heygen, providerChoice heygen, requiredProviders claude+gemini+heygen); (f) cost-estimation.ts new polish26_heygen branch ($0.02 Claude condenser + duration * $0.05/sec HeyGen Avatar V, defaults to 30s = $1.50/video). Do-not-touched: prompt files (Polish-25 script condenser reused as-is), Meta launcher, presets/rules, Sentry, web UI (simplified form + admin surface deferred to Commit 62 alongside webhook receiver + Supabase storage mirror). Regression pin: packages/ai-providers/tests/heygen-v3-client.test.ts locks cost-estimation math + error classifier + script length ceiling + transient detection. Version bump: POLISH_VERSION 25.10.1 -> 26.0.0 (MAJOR bump for backend replacement).";

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
