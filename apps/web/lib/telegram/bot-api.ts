import 'server-only';

/**
 * Minimal direct caller for Telegram's Bot API.
 *
 * Phase 2b uses this for one thing: the disconnect farewell DM. We don't
 * route through the bot service for this — that would add a webhook hop
 * and require the bot to know about user disconnects. Direct call is
 * simpler and the message is fire-and-forget anyway.
 *
 * API: https://core.telegram.org/bots/api
 * Integration date: 2025-05-01
 */

const API_BASE = 'https://api.telegram.org';

export interface SendMessageResult {
  ok: boolean;
  status: number;
  description?: string;
}

/**
 * Send a plain-text message to a chat. Best-effort: callers should NOT
 * block UX on the result. Failures (chat blocked the bot, network down,
 * bot token invalid) are surfaced for logging but never thrown.
 */
export async function sendBotMessage(input: {
  chatId: string;
  text: string;
}): Promise<SendMessageResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, status: 0, description: 'TELEGRAM_BOT_TOKEN not configured' };
  }
  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: input.chatId, text: input.text }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    return {
      ok: res.ok && json?.ok === true,
      status: res.status,
      description: json?.description,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      description: err instanceof Error ? err.message : String(err),
    };
  }
}
