import { eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';
import { computeAndUpsertSummary, type SummaryResult } from './daily-summary-generator';

/**
 * Polish-7.1: manual daily summary triggered by the admin test-actions
 * page. Separate from the cron-based dailySummaryGenerator so the
 * manual path doesn't need to pass the hour-filter SQL and the cron
 * path is untouched.
 *
 * Event shape: { userId, date } — date is informational (logged but
 * not used to override "yesterday" computation; the summary always
 * covers yesterday in the user's timezone).
 */
export const manualDailySummary = inngest.createFunction(
  { id: 'manual-daily-summary', name: 'Manual daily summary', retries: 0 },
  { event: 'summary/daily.requested' },
  async ({ event, step }) => {
    const { userId } = event.data;
    const dryRun = (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true';

    const userRow = await step.run('load-user-tz', async () => {
      const db = getDb();
      return db.query.users.findFirst({
        where: eq(schema.users.id, userId),
        columns: { timezone: true },
      });
    });
    const timezone = userRow?.timezone ?? 'UTC';
    console.log(`[manual-summary] building for user=${userId} timezone=${timezone}`);

    let result: SummaryResult;
    try {
      result = await step.run('build-summary', async () =>
        computeAndUpsertSummary({ userId, timezone, dryRun }),
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(`[manual-summary] build failed for user=${userId}: ${errorMessage}`);
      await logAuditEvent({
        userId,
        eventType: 'daily_summary_build_failed',
        eventData: { error: errorMessage, manual: true },
      });
      await step.sendEvent('manual-summary-fallback', {
        name: 'telegram/notify.requested',
        data: { userId, message: 'Daily summary unavailable — see /dashboard' },
      });
      return { ok: false, error: errorMessage };
    }

    console.log(
      `[manual-summary] user=${userId} inserted=${result.inserted} ` +
        `alreadySent=${result.alreadySentToday} msgLen=${result.message.length}`,
    );

    if (result.alreadySentToday) {
      return { ok: true, alreadySentToday: true };
    }
    if (!result.inserted) {
      return { ok: true, noInsert: true };
    }
    if (dryRun) {
      await logAuditEvent({
        userId,
        eventType: 'daily_summary_skipped_telegram_dry_run',
        eventData: { summary_id: result.summaryId, manual: true },
      });
      return { ok: true, dryRun: true, summaryId: result.summaryId };
    }

    console.log(`[manual-summary] dispatching telegram for user=${userId}`);
    await step.sendEvent('manual-summary-telegram', {
      name: 'telegram/notify.requested',
      data: { userId, message: result.message },
    });
    await step.run('mark-sent', async () => {
      const db = getDb();
      await db
        .update(schema.dailySummaries)
        .set({ telegramSentAt: new Date() })
        .where(eq(schema.dailySummaries.id, result.summaryId));
    });
    console.log(`[manual-summary] done for user=${userId} summaryId=${result.summaryId}`);
    return { ok: true, summaryId: result.summaryId };
  },
);
