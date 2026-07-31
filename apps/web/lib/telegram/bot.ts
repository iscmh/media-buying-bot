import 'server-only';
import { Bot, type Context } from 'grammy';
import { eq } from 'drizzle-orm';
import {
  getActiveLinkByChatId,
  getDb,
  getUserTimezone,
  getDashboardMetrics,
  redeemTelegramLinkCode,
  schema,
  type TimeRange,
} from '@mbb/db';
import { inngest } from '@mbb/jobs';
import { registerPauseCommands } from './commands-pause';
import { registerLaunchCallback, registerLaunchCommand } from './commands-launch';
import { registerSettingsCallback, registerSettingsCommand } from './commands-settings';

/**
 * Polish-25.8 Commit 47: webhook-mode grammy Bot mounted at
 * apps/web/app/api/telegram/webhook/route.ts.
 *
 * Salvages the pre-Commit-34 apps/bot/ command handlers (start / link
 * / status / approval-callback) and adds /help + /stats. The
 * standalone apps/bot/ long-polling process is deleted in the same
 * commit — everything runs inside Next.js on Vercel now.
 *
 * Bot instance is memoized on the module so cold-start init runs
 * once per lambda container. Missing TELEGRAM_BOT_TOKEN → the
 * getter throws; the webhook route catches + 200s so Telegram
 * doesn't retry a mis-configured environment forever.
 */

let cachedBot: Bot | null = null;
let cachedBotToken: string | null = null;

export function getBot(): Bot {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }
  if (cachedBot && cachedBotToken === token) return cachedBot;

  const bot = new Bot(token);
  registerStart(bot);
  registerLink(bot);
  registerHelp(bot);
  registerStatus(bot);
  registerStats(bot);
  // Polish-25.8 Commit 48: full command set.
  registerPauseCommands(bot);
  registerSettingsCommand(bot);
  registerLaunchCommand(bot);
  // Callback handlers — all three inspect data prefix and no-op on
  // non-matching data, so registration order doesn't matter.
  registerApprovalCallback(bot);
  registerSettingsCallback(bot);
  registerLaunchCallback(bot);

  bot.catch((err) => {
    console.error('[telegram-bot] handler error', err);
  });

  cachedBot = bot;
  cachedBotToken = token;
  return bot;
}

// ---------------------------------------------------------------------------
// /start [code] — restored from apps/bot/src/commands/start.ts
// ---------------------------------------------------------------------------
function registerStart(bot: Bot): void {
  bot.command('start', async (ctx) => {
    const arg = ctx.match?.toString().trim();
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply(
        'Could not read chat id from your Telegram message. Try again from a one-on-one chat with the bot.',
      );
      return;
    }

    if (arg) {
      const result = await redeemTelegramLinkCode({
        code: arg,
        tgChatId,
        tgUsername: ctx.from?.username,
      });
      if (!result.ok) {
        if (result.reason === 'expired') {
          await ctx.reply(
            'That link code expired (codes are good for 15 minutes). Generate a new one in the web app and try again.',
          );
        } else {
          await ctx.reply(
            'That code is invalid or has already been used. Generate a new one in the web app and try again.',
          );
        }
        return;
      }
      const email = await lookupEmail(result.userId);
      await ctx.reply(
        `✓ Linked${email ? ` to ${email}` : ''}. You'll get kill/scale prompts and stats here. /help for commands.`,
      );
      return;
    }

    const link = await getActiveLinkByChatId(tgChatId);
    if (link) {
      const email = await lookupEmail(link.userId);
      await ctx.reply(
        `Welcome back${email ? ` (${email})` : ''}. Your account is linked. /help for commands, /stats for a quick snapshot.`,
      );
      return;
    }
    await ctx.reply(
      'Welcome to Ads Bot.\n\nOpen the web app → Settings → Connections → Telegram to generate a link code, then send it back here as `/start <code>` or `/link <code>`.',
    );
  });
}

// ---------------------------------------------------------------------------
// /link <code> — proper redemption (pre-Commit-34 was a stub)
// ---------------------------------------------------------------------------
function registerLink(bot: Bot): void {
  bot.command('link', async (ctx) => {
    const code = ctx.match?.toString().trim();
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply('Could not read chat id from your Telegram message.');
      return;
    }
    if (!code) {
      await ctx.reply(
        'Usage: `/link <code>`. Generate a code in the web app at Settings → Connections → Telegram.',
      );
      return;
    }
    const result = await redeemTelegramLinkCode({
      code,
      tgChatId,
      tgUsername: ctx.from?.username,
    });
    if (!result.ok) {
      await ctx.reply(
        result.reason === 'expired'
          ? 'That link code expired (codes last 15 minutes). Generate a new one and try again.'
          : 'That code is invalid or already used. Generate a new one and try again.',
      );
      return;
    }
    const email = await lookupEmail(result.userId);
    await ctx.reply(`✓ Linked${email ? ` to ${email}` : ''}. /help for commands.`);
  });
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
function registerHelp(bot: Bot): void {
  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        'Ads Bot commands:',
        '',
        '/start [code] - link this chat, or check status',
        '/link <code> - link this chat to your web account',
        '/status - connection + pause snapshot',
        '/stats [24h|7d|30d|all] - spend + conversions + ROAS',
        '/launch - interactively launch approved variants',
        '/pause - freeze all bot auto-actions',
        '/unpause - resume bot',
        '/settings - notification preferences (toggles + subcommands)',
        '/help - this message',
        '',
        'Kill / scale approvals arrive as inline buttons on this chat when the bot recommends action.',
      ].join('\n'),
    );
  });
}

// ---------------------------------------------------------------------------
// /status — restored from apps/bot/src/commands/status.ts
// ---------------------------------------------------------------------------
function registerStatus(bot: Bot): void {
  bot.command('status', async (ctx) => {
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply('Could not read chat id.');
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.reply(
        "This chat isn't linked to a Ads Bot account. Generate a link code in the web app (Settings → Connections → Telegram) and send it as `/link <code>`.",
      );
      return;
    }
    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, link.userId),
      columns: { email: true, isPaused: true },
    });
    await ctx.reply(
      [
        `Account: ${user?.email ?? 'unknown'}`,
        `Bot state: ${user?.isPaused ? 'PAUSED' : 'running'}`,
        user?.isPaused
          ? 'Unpause from the web dashboard when the underlying issue is resolved.'
          : '/stats for spend + performance.',
      ].join('\n'),
    );
  });
}

// ---------------------------------------------------------------------------
// /stats [24h|7d|30d|all]
// ---------------------------------------------------------------------------
function registerStats(bot: Bot): void {
  bot.command('stats', async (ctx) => {
    const arg = ctx.match?.toString().trim().toLowerCase();
    const range: TimeRange =
      arg === '7d' || arg === 'week'
        ? '7d'
        : arg === '30d' || arg === 'month'
          ? '30d'
          : arg === 'all'
            ? 'all'
            : '24h';

    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply('Could not read chat id.');
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.reply('This chat is not linked. Send /help.');
      return;
    }

    const userTimezone = await getUserTimezone(link.userId);
    const metrics = await getDashboardMetrics({
      userId: link.userId,
      range,
      userTimezone,
    });

    const roas =
      metrics.impliedRoas != null
        ? `${metrics.impliedRoas.toFixed(2)}x${metrics.impliedRoasIsEstimate ? '*' : ''}`
        : '-';
    const ctr = metrics.avgCtrPct != null ? `${metrics.avgCtrPct.toFixed(2)}%` : '-';
    const cpc = metrics.avgCpcUsd != null ? `$${metrics.avgCpcUsd.toFixed(2)}` : '-';
    const lines = [
      `Stats - last ${range}`,
      `Spend       $${metrics.totalSpendUsd.toFixed(2)}`,
      `Impressions ${metrics.totalImpressions.toLocaleString()}`,
      `Clicks      ${metrics.totalClicks.toLocaleString()} (CTR ${ctr}, CPC ${cpc})`,
      `Conversions ${metrics.totalConversions.toLocaleString()}`,
      `ROAS        ${roas}`,
      '',
      `Active      ${metrics.adsActiveCount}`,
      `Killed      ${metrics.adsKilledCount}`,
      `Scaled      ${metrics.adsScaledCount}`,
    ];
    if (metrics.impliedRoasIsEstimate) {
      lines.push('', '* ROAS estimated (Meta pixel not sending purchase values).');
    }
    await ctx.reply(lines.join('\n'));
  });
}

// ---------------------------------------------------------------------------
// callback_query for kill/scale approval buttons — restored from apps/bot/
// ---------------------------------------------------------------------------
function registerApprovalCallback(bot: Bot): void {
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith('approve:')) return;

    const parts = data.split(':');
    if (parts.length !== 3) {
      await ctx.answerCallbackQuery({ text: 'Invalid callback data' });
      return;
    }
    const approvalId = parts[1]!;
    const decisionRaw = parts[2]!;
    if (decisionRaw !== 'confirm' && decisionRaw !== 'skip') {
      await ctx.answerCallbackQuery({ text: 'Unknown decision' });
      return;
    }
    const decision: 'confirm' | 'skip' = decisionRaw;

    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.answerCallbackQuery({ text: 'No chat id' });
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.answerCallbackQuery({
        text: 'This chat is not linked. Re-link via the web app.',
        show_alert: true,
      });
      return;
    }

    const db = getDb();
    const approval = await db.query.pendingApprovals.findFirst({
      where: eq(schema.pendingApprovals.id, approvalId),
      columns: {
        userId: true,
        status: true,
        expiresAt: true,
        telegramMessageId: true,
      },
    });
    if (!approval || approval.userId !== link.userId) {
      await ctx.answerCallbackQuery({ text: 'Approval not found.', show_alert: true });
      return;
    }
    if (approval.status !== 'pending') {
      await ctx.answerCallbackQuery({
        text: `Already ${approval.status}.`,
        show_alert: true,
      });
      return;
    }
    if (approval.expiresAt < new Date()) {
      await ctx.answerCallbackQuery({
        text: 'This prompt has expired (24h limit).',
        show_alert: true,
      });
      return;
    }

    if (!approval.telegramMessageId && ctx.callbackQuery?.message?.message_id != null) {
      await db
        .update(schema.pendingApprovals)
        .set({
          telegramMessageId: String(ctx.callbackQuery.message.message_id),
        })
        .where(eq(schema.pendingApprovals.id, approvalId));
    }

    await inngest.send({
      name: 'approval/decision.received',
      data: { approvalId, decision },
    });

    await ctx.answerCallbackQuery({
      text: decision === 'confirm' ? 'Confirming…' : 'Skipping…',
    });
    if (ctx.callbackQuery?.message?.message_id != null) {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // Non-fatal: message may be too old.
      }
    }
  });
}

async function lookupEmail(userId: string): Promise<string | null> {
  try {
    const db = getDb();
    const row = await db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { email: true },
    });
    return row?.email ?? null;
  } catch {
    return null;
  }
}
