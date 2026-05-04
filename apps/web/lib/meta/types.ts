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
