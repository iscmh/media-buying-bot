import { webhookCallback } from 'grammy';
import { NextResponse } from 'next/server';
import { getBot } from '@/lib/telegram/bot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Telegram will retry unbounded times on a non-2xx. Give the handler a
// generous per-invocation budget so a slow DB query doesn't cascade into
// duplicate updates.
export const maxDuration = 30;

/**
 * Polish-25.8 Commit 47: Telegram webhook.
 *
 * Telegram → POST https://<host>/api/telegram/webhook with a JSON
 * Update object. We verify the request came from Telegram via the
 * `x-telegram-bot-api-secret-token` header (matched against
 * TELEGRAM_WEBHOOK_SECRET, set on this route AND registered with
 * Telegram's setWebhook call).
 *
 * grammy's webhookCallback wraps handler dispatch, ack timing, and
 * per-update error isolation. We return 200 on ANY handler outcome
 * (success or handler-throw) so Telegram doesn't retry-storm the
 * lambda — logging is Sentry's job here.
 *
 * If TELEGRAM_BOT_TOKEN is unset (dark ship pre-token), getBot()
 * throws; the outer catch swallows + 200s so Telegram sees a healthy
 * endpoint but no bot response until env vars are configured.
 */

let handler: ((req: Request) => Promise<Response>) | null = null;

function ensureHandler(): (req: Request) => Promise<Response> {
  if (handler) return handler;
  const bot = getBot();
  // grammy's webhookCallback returns a Response-compatible handler
  // when we pass adapter='std/http' (matches Next.js App Router).
  handler = webhookCallback(bot, 'std/http', {
    // Telegram's own hard timeout is ~60s. 25s leaves lambda headroom.
    timeoutMilliseconds: 25_000,
    secretToken: process.env['TELEGRAM_WEBHOOK_SECRET'],
  }) as (req: Request) => Promise<Response>;
  return handler;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const h = ensureHandler();
    return await h(req);
  } catch (err) {
    // Common non-fatal reasons we swallow:
    //   - TELEGRAM_BOT_TOKEN not set (dark ship)
    //   - Wrong secret token (grammy throws HttpError)
    //   - A single handler throwing (shouldn't happen — bot.catch()
    //     absorbs, but belt-and-suspenders)
     
    console.error('[telegram-webhook] swallowed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: true, note: 'swallowed' });
  }
}

// GET returns 200 so operators can eyeball the endpoint in a browser
// to confirm the route is mounted. Real webhook traffic is POST-only.
export async function GET(): Promise<Response> {
  return NextResponse.json({
    ok: true,
    hint: 'POST-only Telegram webhook. Register with setWebhook.',
  });
}
