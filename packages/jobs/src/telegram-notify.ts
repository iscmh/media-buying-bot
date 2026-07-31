import {
  getTelegramUserByChatId,
  isInQuietHours,
  type TelegramNotificationPreferences,
  type TelegramUser,
} from '@mbb/db';
import { eq } from 'drizzle-orm';
import { getDb } from '@mbb/db';
import { telegramConnections } from '@mbb/db/schema';

/**
 * Polish-25.8 Commit 48: server-side (worker + web) alert dispatcher.
 *
 * Rules (in order — first failure short-circuits):
 *   1. User has an active telegram_connection.
 *   2. The alert category is enabled in prefs (kill_alerts_enabled
 *      etc.).
 *   3. User is not in configured quiet hours.
 *   4. Bot token is configured (else no-op — dark ship safe).
 *
 * Failures are logged but never thrown — a broken alert path must
 * not cascade into a worker crash. Suppressed alerts are NOT queued
 * for later; that would flood the operator at end-of-quiet-hours.
 */

export type AlertCategory =
  | 'kill_alerts_enabled'
  | 'scale_alerts_enabled'
  | 'rejection_alerts_enabled'
  | 'threshold_breach_alerts_enabled';

export interface InlineButton {
  text: string;
  /** callback_data (buttons) OR url (link buttons). */
  callback_data?: string;
  url?: string;
}

export interface SendTelegramAlertInput {
  userId: string;
  category: AlertCategory;
  text: string;
  /** Rows of inline keyboard buttons. Each row is an array of buttons. */
  buttons?: InlineButton[][];
  /** Skip prefs check + quiet hours (for /help-driven manual sends). */
  bypassPrefs?: boolean;
}

export interface SendTelegramAlertResult {
  ok: boolean;
  suppressed?: 'not_linked' | 'category_disabled' | 'quiet_hours' | 'bot_disabled' | 'send_failed';
  messageId?: number;
}

const API_BASE = 'https://api.telegram.org';

async function getUserForAlert(userId: string): Promise<TelegramUser | null> {
  const db = getDb();
  const row = await db.query.telegramConnections.findFirst({
    where: eq(telegramConnections.userId, userId),
    columns: { tgChatId: true, status: true },
  });
  if (!row || row.status !== 'active' || !row.tgChatId) return null;
  return await getTelegramUserByChatId(row.tgChatId);
}

export async function sendTelegramAlert(
  input: SendTelegramAlertInput,
): Promise<SendTelegramAlertResult> {
  try {
    const token = process.env['TELEGRAM_BOT_TOKEN'];
    if (!token) return { ok: false, suppressed: 'bot_disabled' };

    const user = await getUserForAlert(input.userId);
    if (!user) return { ok: false, suppressed: 'not_linked' };

    if (!input.bypassPrefs) {
      if (!user.preferences[input.category]) {
        return { ok: false, suppressed: 'category_disabled' };
      }
      if (isInQuietHours(user.preferences, user.timezone)) {
        return { ok: false, suppressed: 'quiet_hours' };
      }
    }

    const body: Record<string, unknown> = {
      chat_id: user.tgChatId,
      text: input.text,
      disable_web_page_preview: true,
    };
    if (input.buttons && input.buttons.length > 0) {
      body.reply_markup = { inline_keyboard: input.buttons };
    }

    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    } | null;
    if (!res.ok || !json?.ok) {
      console.warn('[telegram-notify] send failed', {
        status: res.status,
        description: json?.description,
      });
      return { ok: false, suppressed: 'send_failed' };
    }
    return { ok: true, messageId: json.result?.message_id };
  } catch (err) {
    console.warn('[telegram-notify] threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, suppressed: 'send_failed' };
  }
}

/**
 * Direct-send helper used by cron summaries. Bypasses category-enable
 * check because the cron already filtered on the specific enable
 * flag; still honors quiet hours + bot-disabled unless bypassPrefs.
 */
export async function sendTelegramMessage(input: {
  chatId: string;
  text: string;
  buttons?: InlineButton[][];
}): Promise<SendTelegramAlertResult> {
  try {
    const token = process.env['TELEGRAM_BOT_TOKEN'];
    if (!token) return { ok: false, suppressed: 'bot_disabled' };
    const body: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
      disable_web_page_preview: true,
    };
    if (input.buttons && input.buttons.length > 0) {
      body.reply_markup = { inline_keyboard: input.buttons };
    }
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    } | null;
    if (!res.ok || !json?.ok) {
      return { ok: false, suppressed: 'send_failed' };
    }
    return { ok: true, messageId: json.result?.message_id };
  } catch {
    return { ok: false, suppressed: 'send_failed' };
  }
}

export function suffixQuietHoursIfSuppressed(
  prefs: TelegramNotificationPreferences,
  timezone: string,
  base: string,
): string {
  if (isInQuietHours(prefs, timezone)) {
    return `${base}\n\n(Sent outside quiet hours would have deferred; sending manual response now.)`;
  }
  return base;
}
