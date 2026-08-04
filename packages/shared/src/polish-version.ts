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
export const POLISH_VERSION = '25.10.0';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.10 Commit 59 - Public API + Scale-tier surface. Real: operator scoping for real launch; API access will be the Scale-tier differentiator so build API first, billing implementation deferred. Ships: (a) DB layer - api_keys (SHA-256 hashed bearer tokens, plaintext returned ONCE at create, key_prefix column for identification without decrypt) + api_request_log (60/min sliding-window rate-limit source + audit trail, 7d retention TODO) in migrations 0043 + 0044 with matching Drizzle schemas + RLS (users see own keys/logs, admins see all); (b) DB helpers packages/db/src/api-keys.ts (generateApiKey/hashApiKey/createApiKey/listApiKeys/revokeApiKey/findActiveApiKeyByPlaintext/stampApiKeyLastUsed) + api-rate-limit.ts (checkApiRateLimit sliding-window count via indexed query, recordApiRequest fire-and-forget); (c) apps/web/lib/api-envelope.ts canonical {data} / {error:{code,message,details}} JSON envelope with 7 stable codes (unauthorized/forbidden/not_found/validation_error/rate_limited/conflict/internal_error) + status-code helper; (d) apps/web/lib/api-auth.ts withApi() wrapper - extracts Bearer, hashes+looks-up key, enforces 60/min rate limit with Retry-After header, runs handler with {userId, apiKeyId} context, catches throws to error_log + 500, fire-and-forget last_used stamp + api_request_log insert; (e) apps/web/lib/supabase/service.ts service-role client for storage ops in Bearer-auth context (cookies() doesn't work since API calls send no cookies); (f) middleware.ts extended PUBLIC_PREFIXES with /api/v1 (same 307-fix pattern as Commit 49 Telegram); (g) 12 routes under /api/v1 - POST/GET /concepts (server-side source_url fetch with content-type + size cap), GET /concepts/:id, POST/GET /generations (same estimateGenerationCost + assertDailyCostCap + live-ack gate as web), GET /generations/:id (with variants), POST /variants/:vid/approve + /reject (idempotent), POST /launches (same launchApprovedActionImpl safety envelope - launch-ack + live-ack + page validation + budget minimum + first-live cap + daily-launch cap), GET /launched_ads (real ROAS from current_* columns), POST /launched_ads/:id/kill + /scale (routes through pending_approvals + approval/decision.received Inngest event so worker handles Meta call + audit), GET /presets; (h) apps/web/app/settings/api page with admin OR is_founding_member gate (TODO(Commit 60): add plan_tier='scale' arm when billing lands) + create-key modal (shows plaintext ONCE with copy button + 'You won't see this again' warning) + revoke button + non-Scale users see 'coming soon' card linking to docs; (i) /api/v1/docs public-accessible reference page (endpoints + auth + rate limits + envelope + curl + JS examples); (j) settings/page.tsx quick-nav extended 2->3 cards to include API keys. Do-not-touched: pipeline/worker business logic, prompt files, Meta launcher backend, presets/rules storage. Regression pin: packages/db/tests/api-keys.test.ts (hash round-trip + prefix visibility + revoke soft-flag). Version bump: POLISH_VERSION 25.9.1 -> 25.10.0 (major bump for real product surface).";

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
