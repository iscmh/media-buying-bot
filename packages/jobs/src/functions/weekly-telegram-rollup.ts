import { getDashboardMetrics, isInQuietHours, listTelegramUsers, localHourInZone } from '@mbb/db';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { formatSummary } from '../telegram-format';
import { sendTelegramMessage } from '../telegram-notify';

/**
 * Polish-25.8 Commit 48: weekly rollup dispatcher. Runs hourly and
 * fires per-user on Sunday evening (20:00 local, mapped via
 * localHourInZone + JS day-of-week in the user's zone).
 */
export const weeklyTelegramRollup = inngest.createFunction(
  {
    id: 'weekly-telegram-rollup',
    name: 'Weekly Telegram rollup (Sunday 20:00 local)',
    onFailure: logInngestFailure,
  },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const users = await step.run('list-users', () => listTelegramUsers());
    const now = new Date();
    let sent = 0;
    let suppressed = 0;
    for (const user of users) {
      if (!user.preferences.weekly_rollup_enabled) continue;
      const localHour = localHourInZone(now, user.timezone);
      if (localHour !== 20) continue;
      const localDay = new Date(now.toLocaleString('en-US', { timeZone: user.timezone })).getDay();
      if (localDay !== 0) continue; // 0 = Sunday
      if (isInQuietHours(user.preferences, user.timezone)) {
        suppressed += 1;
        continue;
      }
      try {
        const metrics = await getDashboardMetrics({
          userId: user.userId,
          range: '7d',
          userTimezone: user.timezone,
        });
        const text = formatSummary({
          metrics,
          range: '7d',
          format: user.preferences.summary_format,
          label: 'Week in review (last 7 days)',
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
