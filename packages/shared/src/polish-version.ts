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
export const POLISH_VERSION = '25.7.7';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.7 Commit 46 \u2014 comprehensive first-party error tracking. New error_log table (migration 0041) mirrored by Drizzle schema, admin-only RLS select, service-role insert. packages/db/src/error-log.ts logError() helper: extracts message + stack, runs @mbb/shared/redact scrub over message + stack + context + breadcrumbs (same rules as Sentry beforeSend so no split brain), computes SHA-1 fingerprint over normalized message for grouping, truncates fields to bounded lengths, NEVER throws. packages/db/src/error-log-queries.ts listRecentErrors + listGroupedErrors power the /admin/errors two-view page. Server-side capture: withErrorLogging server-action wrapper + withApiErrorLogging route-handler wrapper (both grab auth'd user_id + call logError with source='server_action'/'api_route'); ExpectedActionError marker skips logging for validation/permission throws. Applied to launchApprovedAction (Meta launch) + unpauseUserAction. Inngest onFailure hook logInngestFailure attached to metaAdLauncher \u2014 post-retry crashes land with source='worker' + eventName. Client-side capture: lib/client-error-logger.ts batches errors, 5s flush, sendBeacon on visibilitychange, rate-limited 10/min per tab, NEVER logs its own failures. BreadcrumbTracker mounted in root layout emits nav + click breadcrumbs (last 20). window.onerror + unhandledrejection attach on first log call. Two React error boundaries: app/error.tsx (per-route) + app/global-error.tsx (root-level, includes own <html>/<body>). /api/log-error POST route receives batched client events, redacts + writes via logError, silently swallows on failure to prevent client-retry loops. /admin/errors page: requireAdmin-gated, URL-driven state (range/sources/severity/user email/search/pagination), Recent view (flat list, expandable stack/context/breadcrumbs) + Grouped view (dedup by fingerprint with count + affected users + first/last seen). Filter chips: time range (1h/24h/7d/30d/all), source multi-select, user email, message text. Nav entry added to SecondaryNavSheet Admin section. Nightly cleanupErrorLog Inngest cron sweeps rows older than 90 days at 03:00 UTC. Sentry pipeline from Commit 44 stays wired unchanged \u2014 the two audit trails complement each other, not compete.";

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
