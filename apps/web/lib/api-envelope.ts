import { NextResponse } from 'next/server';

/**
 * Polish-25.10 Commit 59: canonical JSON envelope for /api/v1/*.
 *
 * On success:  { "data": <payload> }
 * On failure:  { "error": { "code": "...", "message": "...", "details"?: {...} } }
 *
 * The top-level status code carries the success/failure distinction;
 * the envelope is redundant but standardizes client parsing so a
 * consumer can do `if (body.error) …` without inspecting status.
 *
 * Codes are stable strings the client can switch on:
 *   - unauthorized         missing / invalid Bearer
 *   - forbidden            revoked key, safety layer denied, tier gate
 *   - not_found            resource doesn't exist / not yours
 *   - validation_error     body/query failed zod
 *   - rate_limited         >60 req/min for this key
 *   - conflict             already exists / state conflict
 *   - internal_error       unhandled throw (logged to error_log)
 */

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'rate_limited'
  | 'conflict'
  | 'internal_error';

export function apiOk<T>(data: T, init?: ResponseInit): NextResponse<{ data: T }> {
  return NextResponse.json({ data }, init);
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  init?: { status?: number; details?: Record<string, unknown>; headers?: HeadersInit },
): NextResponse<ApiErrorBody> {
  const status = init?.status ?? statusForCode(code);
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(init?.details ? { details: init.details } : {}),
      },
    },
    { status, ...(init?.headers ? { headers: init.headers } : {}) },
  );
}

function statusForCode(code: ApiErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'validation_error':
      return 422;
    case 'rate_limited':
      return 429;
    case 'conflict':
      return 409;
    case 'internal_error':
      return 500;
  }
}
