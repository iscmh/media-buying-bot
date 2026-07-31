import {
  getDashboardMetrics,
  isDailySummaryHour,
  isInQuietHours,
  listTelegramUsers,
} from '@mbb/db';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { formatSummary } from '../telegram-format';
import { sendTelegramMessage } from '../telegram-notify';

/**
 * Polish-25.8 Commit 48: hourly cron that dispatches per-user daily
 * summaries when the current UTC hour maps to each user's configured
 * local `daily_summary_hour_local`. Because we run every hour, DST
 * transitions and every timezone are naturally covered without a
 * per-user schedule.
 *
 * Rules:
 *   - daily_summary_enabled must be true.
 *   - Local hour must match daily_summary_hour_local.
 *   - Quiet hours suppress even if the local hour matches (rare —
 *     someone set summary=8am + quiet=6am-10am).
 *   - Paused users still get summaries (they need to know why to
 *     unpause).
 */
export const dailyTelegramSummary = inngest.createFunction(
  {
    id: 'daily-telegram-summary',
    name: 'Daily Telegram summary (hourly dispatcher)',
    onFailure: logInngestFailure,
  },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const users = await step.run('list-users', () => listTelegramUsers());
    let sent = 0;
    let suppressed = 0;
    for (const user of users) {
      if (!user.preferences.daily_summary_enabled) {
        suppressed += 1;
        continue;
      }
      if (!isDailySummaryHour(user.preferences, user.timezone)) continue;
      if (isInQuietHours(user.preferences, user.timezone)) {
        suppressed += 1;
        continue;
      }
      try {
        const metrics = await getDashboardMetrics({
          userId: user.userId,
          range: '24h',
          userTimezone: user.timezone,
        });
        const text = formatSummary({
          metrics,
          range: '24h',
          format: user.preferences.summary_format,
          label: 'Yesterday',
        });
        const result = await sendTelegramMessage({
          chatId: user.tgChatId,
          text,
        });
        if (result.ok) sent += 1;
        else suppressed += 1;
      } catch {
        suppressed += 1;
      }
    }
    return { sent, suppressed, totalUsers: users.length };
  },
);
