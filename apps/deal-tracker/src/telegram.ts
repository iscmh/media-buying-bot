/**
 * Minimal Telegram Bot API client — no SDK, just fetch. The bot needs
 * exactly two things: push a formatted alert, and long-poll for commands.
 */

const API_BASE = 'https://api.telegram.org';

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly defaultChatId?: string,
  ) {}

  private async call<T>(method: string, body: unknown, timeoutMs = 30_000): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json()) as ApiResponse<T>;
      if (!json.ok) {
        // 429 carries the wait in parameters.retry_after; surface it upward
        // so the caller can back off rather than hammering.
        const retryAfter = json.parameters?.retry_after;
        throw new Error(
          `telegram ${method} failed: ${json.description ?? res.status}` +
            (retryAfter ? ` (retry after ${retryAfter}s)` : ''),
        );
      }
      return json.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendMessage(text: string, chatId?: string): Promise<void> {
    const chat = chatId ?? this.defaultChatId;
    if (!chat) throw new Error('No chat id configured — set TELEGRAM_CHAT_ID');

    // Telegram caps messages at 4096 chars; split on line boundaries.
    for (const chunk of chunkText(text, 3900)) {
      let attempt = 0;
      for (;;) {
        try {
          await this.call('sendMessage', {
            chat_id: chat,
            text: chunk,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
          break;
        } catch (err) {
          attempt++;
          if (attempt >= 3) throw err;
          const wait = retryAfterFrom(err) ?? 2 ** attempt * 1000;
          await sleep(wait);
        }
      }
    }
  }

  async getUpdates(offset: number, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    const result = await this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
      (timeoutSeconds + 10) * 1000,
    );
    return result ?? [];
  }
}

function retryAfterFrom(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /retry after (\d+)s/.exec(message);
  return match?.[1] !== undefined ? Number(match[1]) * 1000 : null;
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ParsedCommand {
  command: string;
  args: string[];
}

/** Parses "/target@my_bot 3200" into { command: 'target', args: ['3200'] }. */
export function parseCommand(text: string | undefined): ParsedCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...args] = trimmed.slice(1).split(/\s+/);
  if (!head) return null;
  const command = (head.split('@')[0] ?? head).toLowerCase();
  return { command, args };
}
