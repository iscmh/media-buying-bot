import 'server-only';
import { logMetaApiCall } from '@mbb/db';
import { META_REQUIRED_SCOPES } from '@mbb/shared';
import type { AdAccountRow, BusinessRow, DebugTokenData } from './types';

/**
 * Read-only Meta Graph API helpers used during onboarding.
 *
 * These bypass the @mbb/meta-api/callMeta chokepoint because callMeta
 * exists for MUTATIONS that move money. Reads (debug_token, list BMs,
 * list ad accounts) don't need spend safety or rate limit reservation.
 *
 * Every call here MUST log via logMetaApiCall (anti-ban guardrail #6) and
 * MUST send the token via Authorization: Bearer (never query string).
 *
 * Pure types/labels live in ./types.ts so client components can import them.
 *
 * API version: v21.0
 * Integration date: 2025-05-01
 */

const META_API_VERSION = process.env.META_API_VERSION ?? 'v21.0';
const META_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

interface MetaGet<T> {
  ok: true;
  data: T;
  status: number;
}
interface MetaError {
  ok: false;
  status: number;
  errorCode?: number;
  message: string;
}
type MetaResult<T> = MetaGet<T> | MetaError;

async function get<T>(
  userId: string,
  endpoint: string,
  accessToken: string,
  query?: Record<string, string>,
): Promise<MetaResult<T>> {
  const url = new URL(`${META_BASE}${endpoint}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const t0 = Date.now();
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    body = { _fetch_error: err instanceof Error ? err.message : String(err) };
  } finally {
    await logMetaApiCall({
      userId,
      endpoint,
      method: 'GET',
      // We don't pass user-supplied query params with secrets; safe to log.
      requestBody: query ?? {},
      responseStatus: status,
      responseBody: body,
      latencyMs: Date.now() - t0,
      dryRun: false,
    });
  }

  if (status >= 200 && status < 300 && body && typeof body === 'object') {
    return { ok: true, status, data: body as T };
  }

  // Meta error envelope: { error: { code, message, type, ... } }
  const metaErr =
    body && typeof body === 'object' && 'error' in body
      ? ((body as { error: { code?: number; message?: string } }).error ?? {})
      : {};
  return {
    ok: false,
    status,
    errorCode: metaErr.code,
    message: metaErr.message ?? `Meta returned HTTP ${status}`,
  };
}

// ----- debug_token -----

export interface VerifyTokenResult {
  ok: boolean;
  /** Set when ok=true. */
  data?: DebugTokenData;
  /** User-facing error explaining what's wrong + how to fix. */
  errorMessage?: string;
}

export async function verifyMetaToken(userId: string, token: string): Promise<VerifyTokenResult> {
  const res = await get<{ data: DebugTokenData }>(userId, '/debug_token', token, {
    input_token: token,
  });

  if (!res.ok) {
    return { ok: false, errorMessage: classifyTokenError(res.errorCode, res.message) };
  }
  const debug = res.data?.data;
  if (!debug || debug.is_valid === false) {
    return {
      ok: false,
      errorMessage:
        'Meta says this token is not valid. Most common causes: the token was revoked in your Meta Developer dashboard, or it wasn’t extended to a long-lived token. Regenerate from the Graph API Explorer and try again.',
    };
  }

  // Scope check.
  const have = new Set(debug.scopes ?? []);
  const missing = META_REQUIRED_SCOPES.filter((s) => !have.has(s));
  if (missing.length > 0) {
    return {
      ok: false,
      errorMessage: `Token is missing required permissions: ${missing.join(', ')}. Regenerate the token in Graph API Explorer with all five required scopes selected.`,
    };
  }

  return { ok: true, data: debug };
}

function classifyTokenError(code: number | undefined, message: string): string {
  // 190 = invalid token, 4 = rate limit on app, 102 = session expired, 463 = expired
  if (code === 190 || code === 463 || code === 102) {
    return 'Meta says this token is invalid or expired. Generate a fresh long-lived token in the Graph API Explorer and try again.';
  }
  if (code === 4) {
    return 'Meta is rate-limiting the verification request. Wait 60 seconds and try again.';
  }
  return `Meta could not verify the token: ${message}. If this keeps happening, try generating a brand new token.`;
}

// ----- /me/businesses -----

export async function listBusinesses(userId: string, token: string): Promise<BusinessRow[]> {
  const res = await get<{ data: BusinessRow[] }>(userId, '/me/businesses', token, {
    fields: 'id,name',
    limit: '100',
  });
  if (!res.ok) throw new Error(res.message);
  return res.data?.data ?? [];
}

// ----- /me/adaccounts -----

export async function listAdAccounts(userId: string, token: string): Promise<AdAccountRow[]> {
  const res = await get<{ data: AdAccountRow[] }>(userId, '/me/adaccounts', token, {
    // Polish-3.5: pulls currency + timezone_name on the listing call so we
    // can persist them on meta_connections at select-time. No extra
    // round-trip per account.
    fields: 'id,name,account_status,currency,timezone_name,business{id,name}',
    limit: '100',
  });
  if (!res.ok) throw new Error(res.message);
  return res.data?.data ?? [];
}

/**
 * Polish-3.5: list the FB Pages the user is admin of. Returns page id,
 * name, page-scoped access token, and the tasks array (used to confirm
 * the user can CREATE_CONTENT). Persisted on meta_connections.pages.
 */
export async function listUserPages(
  userId: string,
  token: string,
): Promise<import('./types').MetaPageRow[]> {
  const res = await get<{ data: import('./types').MetaPageRow[] }>(userId, '/me/accounts', token, {
    fields: 'id,name,access_token,tasks',
    limit: '100',
  });
  if (!res.ok) throw new Error(res.message);
  return res.data?.data ?? [];
}

// ----- DELETE /me/permissions (revoke) -----

/**
 * Best-effort token revoke. Phase 2b disconnect flow calls this BEFORE
 * soft-deleting the local row. On failure (network, Meta down, token
 * already invalid) we proceed with the local disconnect — the token will
 * expire in ≤60 days anyway, so leaving it active for that window is an
 * acceptable worst case. Always logs to meta_api_call_logs.
 */
export async function revokeMetaToken(
  userId: string,
  token: string,
): Promise<{ ok: boolean; status: number }> {
  const url = `${META_BASE}/me/permissions`;
  const t0 = Date.now();
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    body = { _fetch_error: err instanceof Error ? err.message : String(err) };
  } finally {
    await logMetaApiCall({
      userId,
      endpoint: '/me/permissions',
      method: 'DELETE',
      requestBody: {},
      responseStatus: status,
      responseBody: body,
      latencyMs: Date.now() - t0,
      dryRun: false,
    });
  }
  return { ok: status >= 200 && status < 300, status };
}
