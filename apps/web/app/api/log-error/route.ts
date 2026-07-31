import { NextResponse } from 'next/server';
import { logError } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polish-25.7 Commit 46: sink for client-side batched errors.
 *
 * Called by the client-error-logger every 5s (or on visibility=hidden
 * via sendBeacon). Writes each event to error_log with the SAME
 * redaction path used by server-side errors — no unredacted bytes
 * ever hit disk.
 *
 * Guarded:
 *   - Max 20 events per POST (client-side batch cap is 10; buffer).
 *   - Rejects payloads > 512 KiB.
 *   - Attaches auth'd user_id if the request carries a session
 *     cookie; anonymous errors still get logged (user_id = null).
 *   - Never NOT-2xx — a broken sink would trigger an infinite loop
 *     if the client logger retried on failure (it doesn't, but
 *     belt-and-suspenders).
 */

const MAX_EVENTS_PER_POST = 20;
const MAX_BODY_BYTES = 512 * 1024;

interface ClientEvent {
  source: 'client_render' | 'client_boundary' | 'unhandled_promise';
  sourceName?: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  breadcrumbs?: Array<Record<string, unknown>>;
  severity?: 'error' | 'warning' | 'info';
  timestamp: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const contentLength = req.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: true, dropped: 'oversized' });
    }
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ ok: true, dropped: 'oversized' });

    let parsed: { events?: ClientEvent[] };
    try {
      parsed = JSON.parse(raw) as { events?: ClientEvent[] };
    } catch {
      return NextResponse.json({ ok: true, dropped: 'malformed' });
    }
    const events = Array.isArray(parsed.events) ? parsed.events.slice(0, MAX_EVENTS_PER_POST) : [];

    let userId: string | null = null;
    try {
      const supabase = await getSupabaseServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      userId = user?.id ?? null;
    } catch {
      // ignore — anonymous is fine
    }

    // Sequential to keep DB pool pressure bounded. Batch is tiny.
    for (const evt of events) {
      if (!evt || typeof evt.message !== 'string') continue;
      await logError({
        userId,
        source: evt.source,
        sourceName: evt.sourceName ?? null,
        error: (() => {
          const e = new Error(evt.message);
          if (evt.stack) e.stack = evt.stack;
          return e;
        })(),
        context: {
          ...(evt.context ?? {}),
          client_timestamp: evt.timestamp,
        },
        breadcrumbs: evt.breadcrumbs ?? [],
        severity: evt.severity ?? 'error',
      });
    }
    return NextResponse.json({ ok: true, count: events.length });
  } catch {
    // Never let this route surface a 500 — client logger would
    // (in a future retry-happy version) hammer it. Silently drop.
    return NextResponse.json({ ok: true, dropped: 'internal' });
  }
}
