import 'server-only';
import { logError } from '@mbb/db';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Polish-25.7 Commit 46: API-route wrapper analogous to
 * withErrorLogging. Wrap a route's exported handler so an unhandled
 * throw lands in error_log and the client still gets a 500.
 *
 * Usage:
 *   export const POST = withApiErrorLogging('log-error', async (req) => {
 *     ...
 *   });
 */

type AnyRouteHandler = (
  req: Request,
  ctx?: { params: Record<string, string | string[]> },
) => Promise<Response> | Response;

export function withApiErrorLogging(sourceName: string, handler: AnyRouteHandler): AnyRouteHandler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      let userId: string | null = null;
      try {
        const supabase = await getSupabaseServerClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        userId = user?.id ?? null;
      } catch {
        // ignore
      }
      const url = new URL(req.url);
      await logError({
        userId,
        source: 'api_route',
        sourceName,
        error: err,
        context: {
          method: req.method,
          path: url.pathname,
          search: url.search,
        },
      });
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
  };
}
