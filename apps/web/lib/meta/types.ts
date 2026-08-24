/**
 * Shared Meta types and pure helpers usable from BOTH server and client.
 *
 * The fetch-the-API helpers live in `./graph-api.ts`, which is server-only
 * because they touch tokens and write to meta_api_call_logs.
 */

export interface DebugTokenData {
  app_id: string;
  user_id: string;
  expires_at: number; // unix seconds; 0 means never expires
  is_valid: boolean;
  scopes: string[];
  /**
   * Polish-28.4.8 Commit 106: Meta stamps this on /debug_token so the
   * caller can tell a SYSTEM_USER token (scaled, non-alarming) from a
   * USER token (personal FB account, triggers Meta's "compromised
   * account" fraud alarm on first server-side API call).
   * Reference: https://developers.facebook.com/docs/graph-api/reference/debug_token/
   */
  type?: 'USER' | 'SYSTEM_USER' | 'PAGE' | 'APP';
}

export interface BusinessRow {
  id: string;
  name: string;
}

export interface AdAccountRow {
  id: string; // act_<numeric>
  name: string;
  account_status: number;
  business?: { id: string; name: string };
  /** Polish-3.5: ISO currency code (USD/RON/...). Drives launch-time
   *  USD→account conversion. */
  currency?: string;
  /** IANA tz name (e.g. "Europe/Bucharest"). Display only for now. */
  timezone_name?: string;
}

/**
 * Polish-3.5: per-page record from /me/accounts?fields=id,name,
 * access_token,tasks. Stored on meta_connections.pages at select-time
 * so the launch path can validate the picked page id + pull the
 * page-scoped access token without re-hitting Meta.
 */
export interface MetaPageRow {
  id: string;
  name: string;
  access_token?: string;
  tasks?: string[];
}

/** account_status: 1=active, 2=disabled, 3=unsettled, 7=pending_risk, 8=pending_settlement, 9=in_grace_period, 100=closed */
export const AD_ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1: 'Active',
  2: 'Disabled',
  3: 'Unsettled',
  7: 'Pending risk review',
  8: 'Pending settlement',
  9: 'In grace period',
  100: 'Closed',
  101: 'Pending closure',
  201: 'Any active',
  202: 'Any closed',
};

export function isAdAccountSelectable(status: number): boolean {
  return status === 1 || status === 9;
}
