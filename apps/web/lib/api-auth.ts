import 'server-only';
import {
  checkApiRateLimit,
  findActiveApiKeyByPlaintext,
  logError,
  recordApiRequest,
  stampApiKeyLastUsed,
} from '@mbb/db';
import { apiError, type ApiErrorBody } from '@/lib/api-envelope';

/**
 * Polish-25.10 Commit 59: single entry point for /api/v1/* auth +
 * rate limit + audit log.
 *
 * Usage:
 *
 *   export const POST = withApi('concepts.create', async (req, ctx) => {
 *     // ctx.userId + ctx.apiKeyId are guaranteed set here
 *     ...
 *     return apiOk({ ... });
 *   });
 *
 * The wrapper:
 *   1. Extracts `Authorization: Bearer sk_live_XXX`
 *   2. Looks up the key by hash — 401 if unknown / revoked
 *   3. Checks the 60/min sliding-window rate limit — 429 if over
 *      (with Retry-After header)
 *   4. Runs the handler
 *   5. Stamps last_used_at + inserts an api_request_log row with the
 *      response status (best-effort, never fails the response)
 *   6. Catches unhandled throws → 500 + error_log entry
 *
 * The handler MUST return a Response. It may throw for a hard 500;
 * for user-facing failures return apiError('...') directly.
 */

type ApiContext = {
  userId: string;
  apiKeyId: string;
  params?: Record<string, string | string[]>;
};

type ApiHandler = (req: Request, ctx: ApiContext) => Promise<Response>;

export function withApi(
  sourceName: string,
  handler: ApiHandler,
): (req: Request, ctx?: { params: Record<string, string | string[]> }) => Promise<Response> {
  return async (req, routeCtx) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // 1. Extract token.
    const auth = req.headers.get('authorization');
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
      return apiError('unauthorized', 'Missing Authorization: Bearer <api key> header.');
    }
    const plaintext = auth.slice('bearer '.length).trim();
    if (!plaintext) {
      return apiError('unauthorized', 'Empty Bearer token.');
    }

    // 2. Look up + verify.
    const key = await findActiveApiKeyByPlaintext(plaintext);
    if (!key) {
      return apiError('unauthorized', 'Invalid or revoked API key.');
    }

    // 3. Rate limit.
    const rate = await checkApiRateLimit(key.id);
    if (!rate.allowed) {
      const res = apiError(
        'rate_limited',
        `Rate limit exceeded: ${rate.limit} requests per ${rate.retryAfterSeconds}s. Retry after ${rate.retryAfterSeconds}s.`,
        {
          headers: {
            'Retry-After': String(rate.retryAfterSeconds),
            'X-RateLimit-Limit': String(rate.limit),
            'X-RateLimit-Remaining': '0',
          },
        },
      );
      // Log the throttled request so it counts against the window
      // (otherwise a burst-and-back-off client sees the window
      // reset artificially fast).
      void recordApiRequest({
        apiKeyId: key.id,
        userId: key.userId,
        method: req.method,
        path,
        statusCode: 429,
      });
      return res;
    }

    // 4. Run handler.
    let response: Response;
    try {
      response = await handler(req, {
        userId: key.userId,
        apiKeyId: key.id,
        ...(routeCtx?.params ? { params: routeCtx.params } : {}),
      });
    } catch (err) {
      await logError({
        userId: key.userId,
        source: 'api_route',
        sourceName,
        error: err,
        context: {
          method: req.method,
          path,
          search: url.search,
          api_key_id: key.id,
        },
      });
      response = apiError('internal_error', 'Something broke on our end. This has been logged.');
    }

    // 5. Best-effort audit + last-used stamp. Fire-and-forget.
    void stampApiKeyLastUsed(key.id);
    void recordApiRequest({
      apiKeyId: key.id,
      userId: key.userId,
      method: req.method,
      path,
      statusCode: response.status,
    });

    return response;
  };
}

/**
 * Parse + validate the JSON body of an API request. Returns either
 * the parsed data or an already-formed 422 response.
 */
export async function parseJsonBody<T>(
  req: Request,
  schema: {
    safeParse: (v: unknown) =>
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: Array<{ path: (string | number)[]; message: string }> };
        };
  },
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      ok: false,
      response: apiError('validation_error', 'Request body must be valid JSON.'),
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      response: apiError('validation_error', first?.message ?? 'Invalid request body.', {
        details: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      }),
    };
  }
  return { ok: true, data: parsed.data };
}

export type { ApiContext, ApiHandler, ApiErrorBody };
