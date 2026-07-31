import { lt } from 'drizzle-orm';
import { getDb } from '@mbb/db';
import { errorLog } from '@mbb/db/schema';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';

/**
 * Polish-25.7 Commit 46: nightly retention sweep on error_log.
 *
 * Deletes rows older than 90 days. Runs at 03:00 UTC to avoid the
 * hourly-cron rush hour. Keeps the beta cohort's table bounded —
 * even at 1000 errors/day sustained, we cap at ~90k rows.
 *
 * Idempotent: rerunning the same tick deletes nothing (no rows old
 * enough anymore).
 */
const RETENTION_DAYS = 90;

export const cleanupErrorLog = inngest.createFunction(
  {
    id: 'cleanup-error-log',
    name: 'Cleanup error_log (90d retention)',
    onFailure: logInngestFailure,
  },
  { cron: '0 3 * * *' },
  async ({ step }) => {
    return await step.run('delete-old-rows', async () => {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const db = getDb();
      const result = await db
        .delete(errorLog)
        .where(lt(errorLog.createdAt, cutoff))
        .returning({ id: errorLog.id });
      return { deleted: result.length, cutoffIso: cutoff.toISOString() };
    });
  },
);
