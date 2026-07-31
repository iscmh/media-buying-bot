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
export const POLISH_VERSION = '25.8.1';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-25.8 Commit 48 \u2014 Telegram bot full feature set (deferred from Commit 47). Migration 0042 adds telegram_connections.notification_preferences jsonb + telegram_conversation_state table for multi-turn bot state (15-min TTL). New @mbb/db helpers: getTelegramUserByChatId, listTelegramUsers, getTelegramPreferences, updateTelegramPreferences, isInQuietHours, isDailySummaryHour, localHourInZone, getConversationState + set + clear + prune. Bot commands added: /pause (cascade-pauses user), /unpause (mirrors web UnpauseButton including meta-still-disconnected warning), /settings (renders inline toggle keyboard for kill/scale/rejection/threshold/weekly/daily/quiet_hours enable flags + summary_format cycle; subcommands 'daily HH:MM', 'quiet H H', 'format compact|detailed|verbose', 'kill|scale|rejection|threshold on|off'), /launch (interactive multi-turn \u2014 pick approved-variant job, pick per-ad daily budget from $5/$10/$20/$50/$100, confirm; dispatches same meta/launch.requested event as web launch dialog; state stored in telegram_conversation_state with 15-min TTL; refuses if bot is paused or Meta disconnected). Two new Inngest crons: dailyTelegramSummary (hourly dispatcher, fires per user when local hour matches daily_summary_hour_local, respects quiet hours + enable flag), weeklyTelegramRollup (Sunday 20:00 local per user timezone). Alerts wired: kill + scale via alertCategory field on the existing telegram/notify.requested event; telegramNotifier now honors category-enabled + quiet-hours prefs before send. Rejection alerts via direct sendTelegramAlert call from meta-ad-launcher on rejected_by_meta path. Threshold-breach alert infrastructure ready (category exists, notifier honors it) but no worker fires it today \u2014 suspicious-activity-monitor is stubbed pre-Phase 5. Web settings UI: TelegramPanel gained PreferencesEditor with instant-apply toggles + numeric inputs for daily hour + quiet hours + summary format dropdown. Mirrors bot /settings; both surfaces write through updateTelegramPreferences so they stay in sync. Summary formatters (compact/detailed/verbose) in packages/jobs/src/telegram-format.ts.";

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
