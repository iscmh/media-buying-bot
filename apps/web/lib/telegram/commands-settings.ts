import 'server-only';
import type { Bot, Context } from 'grammy';
import {
  getActiveLinkByChatId,
  getTelegramPreferences,
  updateTelegramPreferences,
  type TelegramNotificationPreferences,
} from '@mbb/db';

/**
 * Polish-25.8 Commit 48: /settings command + inline toggle buttons.
 *
 * Bare /settings renders current preferences with inline buttons for
 * each toggle-able field. Tap → callback_query fires → helper below
 * updates the stored jsonb and edits the message in place.
 *
 * Subcommands:
 *   /settings daily HH:MM      — set daily_summary_hour_local
 *   /settings daily on|off     — toggle daily_summary_enabled
 *   /settings quiet HH HH      — set quiet_hours_start/end (0-23)
 *   /settings quiet on|off     — toggle quiet_hours_enabled
 *   /settings format compact|detailed|verbose
 *   /settings kill|scale|rejection|threshold on|off
 *   /settings weekly on|off
 */
export function registerSettingsCommand(bot: Bot): void {
  bot.command('settings', async (ctx) => {
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply('Could not read chat id.');
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.reply("This chat isn't linked. /help for setup.");
      return;
    }

    const arg = ctx.match?.toString().trim() ?? '';
    if (arg) {
      const patch = parseSettingsPatch(arg);
      if (patch.error) {
        await ctx.reply(`Bad syntax: ${patch.error}\nSend bare /settings for the toggle UI.`);
        return;
      }
      const next = await updateTelegramPreferences(link.userId, patch.patch);
      await ctx.reply(`✓ Updated.\n\n${renderPrefsSummary(next)}`);
      return;
    }

    const prefs = await getTelegramPreferences(link.userId);
    await ctx.reply(renderPrefsSummary(prefs), {
      reply_markup: { inline_keyboard: buildSettingsKeyboard(prefs) },
    });
  });
}

/**
 * callback_query handler for tap-toggle buttons. Data format:
 *   settings:<field>          — boolean toggle
 *   settings:format:<value>   — format cycle
 */
export function registerSettingsCallback(bot: Bot): void {
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith('settings:')) return;

    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.answerCallbackQuery({ text: 'No chat id' });
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.answerCallbackQuery({
        text: 'Not linked. Re-link via the web app.',
        show_alert: true,
      });
      return;
    }

    const parts = data.split(':');
    const field = parts[1];
    const value = parts[2];
    const patch: Partial<TelegramNotificationPreferences> = {};

    if (
      field === 'format' &&
      (value === 'compact' || value === 'detailed' || value === 'verbose')
    ) {
      patch.summary_format = value;
    } else if (field && BOOLEAN_FIELDS.includes(field)) {
      const prefs = await getTelegramPreferences(link.userId);
      const key = field as keyof TelegramNotificationPreferences;
      const current = prefs[key];
      if (typeof current === 'boolean') {
        (patch as Record<string, unknown>)[key] = !current;
      }
    } else {
      await ctx.answerCallbackQuery({ text: 'Unknown toggle' });
      return;
    }

    const next = await updateTelegramPreferences(link.userId, patch);
    await ctx.answerCallbackQuery({ text: '✓ Updated' });
    try {
      await ctx.editMessageText(renderPrefsSummary(next), {
        reply_markup: { inline_keyboard: buildSettingsKeyboard(next) },
      });
    } catch {
      // Non-fatal (message too old, etc.)
    }
  });
}

const BOOLEAN_FIELDS = [
  'daily_summary_enabled',
  'weekly_rollup_enabled',
  'kill_alerts_enabled',
  'scale_alerts_enabled',
  'rejection_alerts_enabled',
  'threshold_breach_alerts_enabled',
  'quiet_hours_enabled',
];

function renderPrefsSummary(p: TelegramNotificationPreferences): string {
  return [
    '⚙️ Notification settings',
    '',
    `Daily summary     ${onOff(p.daily_summary_enabled)}  (${String(p.daily_summary_hour_local).padStart(2, '0')}:00 local)`,
    `Weekly rollup     ${onOff(p.weekly_rollup_enabled)}`,
    `Kill alerts       ${onOff(p.kill_alerts_enabled)}`,
    `Scale alerts      ${onOff(p.scale_alerts_enabled)}`,
    `Rejection alerts  ${onOff(p.rejection_alerts_enabled)}`,
    `Threshold alerts  ${onOff(p.threshold_breach_alerts_enabled)}`,
    `Quiet hours       ${onOff(p.quiet_hours_enabled)}  (${String(p.quiet_hours_start_local).padStart(2, '0')}:00-${String(p.quiet_hours_end_local).padStart(2, '0')}:00 local)`,
    `Summary format    ${p.summary_format}`,
    '',
    'Tap a button below to toggle. Or send:',
    '  /settings daily HH:MM',
    '  /settings quiet HH HH',
    '  /settings format compact|detailed|verbose',
  ].join('\n');
}

function onOff(b: boolean): string {
  return b ? '🟢 ON' : '⚪️ off';
}

function buildSettingsKeyboard(p: TelegramNotificationPreferences) {
  const row = (label: string, key: string, active: boolean) => ({
    text: `${active ? '🟢' : '⚪️'} ${label}`,
    callback_data: `settings:${key}`,
  });
  return [
    [
      row('Daily', 'daily_summary_enabled', p.daily_summary_enabled),
      row('Weekly', 'weekly_rollup_enabled', p.weekly_rollup_enabled),
    ],
    [
      row('Kill', 'kill_alerts_enabled', p.kill_alerts_enabled),
      row('Scale', 'scale_alerts_enabled', p.scale_alerts_enabled),
    ],
    [
      row('Rejection', 'rejection_alerts_enabled', p.rejection_alerts_enabled),
      row('Threshold', 'threshold_breach_alerts_enabled', p.threshold_breach_alerts_enabled),
    ],
    [row('Quiet hours', 'quiet_hours_enabled', p.quiet_hours_enabled)],
    [
      {
        text: `Format: compact${p.summary_format === 'compact' ? ' ✓' : ''}`,
        callback_data: 'settings:format:compact',
      },
      {
        text: `detailed${p.summary_format === 'detailed' ? ' ✓' : ''}`,
        callback_data: 'settings:format:detailed',
      },
      {
        text: `verbose${p.summary_format === 'verbose' ? ' ✓' : ''}`,
        callback_data: 'settings:format:verbose',
      },
    ],
  ];
}

function parseSettingsPatch(arg: string): {
  patch: Partial<TelegramNotificationPreferences>;
  error?: string;
} {
  const tokens = arg.split(/\s+/);
  const cmd = tokens[0]?.toLowerCase();
  const val = tokens[1]?.toLowerCase();
  const val2 = tokens[2]?.toLowerCase();

  if (cmd === 'daily') {
    if (val === 'on' || val === 'off') return { patch: { daily_summary_enabled: val === 'on' } };
    if (val && /^\d{1,2}(:\d{2})?$/.test(val)) {
      const hour = Number(val.split(':')[0]);
      if (Number.isFinite(hour) && hour >= 0 && hour <= 23)
        return { patch: { daily_summary_hour_local: hour } };
    }
    return { patch: {}, error: 'usage: /settings daily on|off  OR  /settings daily HH:MM' };
  }
  if (cmd === 'weekly' && (val === 'on' || val === 'off')) {
    return { patch: { weekly_rollup_enabled: val === 'on' } };
  }
  if (cmd === 'quiet') {
    if (val === 'on' || val === 'off') return { patch: { quiet_hours_enabled: val === 'on' } };
    if (val && val2 && /^\d{1,2}$/.test(val) && /^\d{1,2}$/.test(val2)) {
      const s = Number(val);
      const e = Number(val2);
      if (s >= 0 && s <= 23 && e >= 0 && e <= 23)
        return {
          patch: {
            quiet_hours_enabled: true,
            quiet_hours_start_local: s,
            quiet_hours_end_local: e,
          },
        };
    }
    return {
      patch: {},
      error: 'usage: /settings quiet on|off  OR  /settings quiet <start-hour> <end-hour>',
    };
  }
  if (cmd === 'format' && (val === 'compact' || val === 'detailed' || val === 'verbose')) {
    return { patch: { summary_format: val } };
  }
  if (
    (cmd === 'kill' || cmd === 'scale' || cmd === 'rejection' || cmd === 'threshold') &&
    (val === 'on' || val === 'off')
  ) {
    const key =
      cmd === 'kill'
        ? 'kill_alerts_enabled'
        : cmd === 'scale'
          ? 'scale_alerts_enabled'
          : cmd === 'rejection'
            ? 'rejection_alerts_enabled'
            : 'threshold_breach_alerts_enabled';
    return { patch: { [key]: val === 'on' } as Partial<TelegramNotificationPreferences> };
  }
  return { patch: {}, error: `unrecognized "${arg}"` };
}
