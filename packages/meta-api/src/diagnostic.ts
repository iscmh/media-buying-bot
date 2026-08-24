/**
 * Polish-28.4.2 Commit 100: Meta ad-account diagnostic.
 *
 * Read-only probe that fetches enough state from Meta's Graph API to
 * tell an operator exactly why their account isn't launching. Covers
 * the failure modes buyers usually confuse for "shadowban":
 *
 *   - account_status ∈ {2,3,7,8,100,101} — Disabled / Unsettled /
 *     Pending risk review / Pending settlement / Closed
 *   - disable_reason != 0 — Meta's own numeric code for WHY it's flagged
 *     (ads_integrity_policy, gray_account, risk_payment, etc.)
 *   - Special Ad Categories enrollment — cryptic-age-error root cause
 *   - Missing funding source
 *   - Token can't list campaigns (permission / scope issue)
 *
 * Bypasses the `callMeta` chokepoint deliberately. The chokepoint's
 * three gates exist to protect against spend: safety layer, rate
 * limits, dry-run kill switch. All three are irrelevant for a
 * read-only GET on account metadata — the diagnostic must run even
 * when the safety layer has the user paused (that's WHY they need to
 * diagnose) and when BOT_DRY_RUN is on (otherwise the tool returns
 * empty in every non-production environment). Direct fetch is the
 * right primitive here.
 */

const META_API_VERSION = 'v20.0';
const META_TIMEOUT_MS = 15_000;

/** account_status codes returned by Meta on /act_<id>?fields=account_status. */
export const META_ACCOUNT_STATUS: Record<number, string> = {
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

/**
 * disable_reason codes. 0 = not disabled. Non-zero = Meta's own numeric
 * reason. This list is from the public Marketing API docs; Meta ships
 * new codes sometimes so unknown ones surface as the raw number.
 */
export const META_DISABLE_REASON: Record<number, string> = {
  0: 'None',
  1: 'Ads Integrity Policy',
  2: 'Ads IP Review',
  3: 'Risk Payment',
  4: 'Gray Account',
  5: 'Ads Afc Review',
  6: 'Business Integrity Rar',
  7: 'Permanent Close',
  8: 'Unused Reset Policy',
  9: 'Ads Merchant Policy',
  10: 'Compromised',
  11: 'Compromised Overturned',
  12: 'Fraud Overturned',
};

export type DiagnosticSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface DiagnosticFinding {
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface AdAccountDiagnostic {
  ok: boolean;
  adAccountId: string;
  accountName: string | null;
  status: { code: number; label: string; isLaunchable: boolean } | null;
  disableReason: { code: number; label: string } | null;
  currency: string | null;
  timezoneName: string | null;
  business: { id: string; name: string } | null;
  hasFundingSource: boolean | null;
  isEnrolledInSpecialAdCategory: boolean | null;
  canListCampaigns: boolean | null;
  findings: DiagnosticFinding[];
  /** Full raw response body from Meta for debugging. */
  rawResponse: unknown;
  /** Non-null if the fetch itself failed (network / 4xx / 5xx). */
  fetchError: string | null;
}

/**
 * Run the diagnostic against ONE ad account. Caller loops for
 * multi-account connections.
 */
export async function diagnoseAdAccount(input: {
  accessToken: string;
  adAccountId: string;
}): Promise<AdAccountDiagnostic> {
  const findings: DiagnosticFinding[] = [];

  // Phase 1: fetch account metadata.
  const fields = [
    'name',
    'account_id',
    'account_status',
    'disable_reason',
    'currency',
    'timezone_name',
    'business',
    'funding_source_details',
    'capabilities',
    'tos_accepted',
    'age',
  ].join(',');

  const url = `https://graph.facebook.com/${META_API_VERSION}/${input.adAccountId}?fields=${fields}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);

  let rawResponse: unknown = null;
  let fetchError: string | null = null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      rawResponse = JSON.parse(text);
    } catch {
      rawResponse = { _non_json: text.slice(0, 4096) };
    }
    if (res.status < 200 || res.status >= 300) {
      const errBody = rawResponse as {
        error?: { message?: string; code?: number; error_subcode?: number };
      };
      const msg = errBody?.error?.message ?? `HTTP ${res.status}`;
      fetchError = `Meta rejected the account fetch: ${msg} (code ${errBody?.error?.code ?? 'n/a'}, subcode ${errBody?.error?.error_subcode ?? 'n/a'})`;
      findings.push({
        severity: 'error',
        title: 'Cannot fetch account details from Meta',
        detail: fetchError,
        suggestion:
          errBody?.error?.code === 190
            ? 'Access token invalid or expired. Reconnect Meta in Settings.'
            : errBody?.error?.code === 200
              ? 'Token lacks permission to read this ad account. Regenerate the token with ads_management + ads_read scopes and reselect the ad account.'
              : 'If this persists, paste the raw error to support.',
      });
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
    findings.push({
      severity: 'error',
      title: 'Meta API unreachable',
      detail: fetchError,
      suggestion: 'Retry in a moment. If it keeps failing, Meta may be having an outage.',
    });
  } finally {
    clearTimeout(timeout);
  }

  if (fetchError) {
    return {
      ok: false,
      adAccountId: input.adAccountId,
      accountName: null,
      status: null,
      disableReason: null,
      currency: null,
      timezoneName: null,
      business: null,
      hasFundingSource: null,
      isEnrolledInSpecialAdCategory: null,
      canListCampaigns: null,
      findings,
      rawResponse,
      fetchError,
    };
  }

  const acct = rawResponse as {
    name?: string;
    account_status?: number;
    disable_reason?: number;
    currency?: string;
    timezone_name?: string;
    business?: { id: string; name: string };
    funding_source_details?: unknown;
    capabilities?: string[];
    tos_accepted?: Record<string, unknown>;
  };

  const statusCode = acct.account_status ?? -1;
  const statusLabel = META_ACCOUNT_STATUS[statusCode] ?? `Unknown (${statusCode})`;
  const isLaunchable = statusCode === 1 || statusCode === 9;

  const disableCode = acct.disable_reason ?? 0;
  const disableLabel = META_DISABLE_REASON[disableCode] ?? `Unknown (${disableCode})`;

  const capabilities = Array.isArray(acct.capabilities) ? acct.capabilities : [];
  // Meta stamps these ONLY when the account is under Special Ad Category
  // enforcement — the ACCOUNT itself has to abide by SAC rules
  // regardless of what you say per-campaign. Explicit allowlist because
  // a substring match on "POLITICAL" was firing on CAN_SEE_POLITICAL_FLOW
  // (a UI-permission capability every account has, unrelated to SAC
  // enforcement) and false-flagging clean accounts.
  const SAC_ENFORCEMENT_CAPS: ReadonlyArray<string> = [
    'SPECIAL_AD_CATEGORY_LEGACY',
    'SPECIAL_AD_CATEGORY_ENFORCED',
    'SPECIAL_AD_CATEGORY_CREDIT',
    'SPECIAL_AD_CATEGORY_HOUSING',
    'SPECIAL_AD_CATEGORY_EMPLOYMENT',
    'SPECIAL_AD_CATEGORY_ISSUES_ELECTIONS_POLITICS',
    'CREDIT_ADS_ENFORCED',
    'HOUSING_ADS_ENFORCED',
    'EMPLOYMENT_ADS_ENFORCED',
    'POLITICAL_ADS_ENFORCED',
  ];
  const sacCapabilities = capabilities.filter(
    (c): c is string => typeof c === 'string' && SAC_ENFORCEMENT_CAPS.includes(c),
  );
  const isEnrolledInSpecialAdCategory = sacCapabilities.length > 0;

  const hasFundingSource =
    acct.funding_source_details != null &&
    typeof acct.funding_source_details === 'object' &&
    Object.keys(acct.funding_source_details as Record<string, unknown>).length > 0;

  // Findings — order matters, most severe first.
  if (!isLaunchable) {
    findings.push({
      severity: statusCode === 2 || statusCode === 100 ? 'error' : 'warning',
      title: `Account status: ${statusLabel} (code ${statusCode})`,
      detail:
        statusCode === 2
          ? 'Meta has disabled this account. New ads are refused until the account is reinstated.'
          : statusCode === 3
            ? 'Account has an unpaid balance. Meta blocks new launches until it settles.'
            : statusCode === 7
              ? "Meta placed the account under a manual risk review. This is the classic 'shadowban' pattern — the account isn't dead, but Meta parks it while their integrity systems decide. There is no manual override; you wait, or appeal via Account Quality."
              : statusCode === 8
                ? 'Payment method is in a settlement state (usually a failed charge). Update the funding source in Ads Manager.'
                : statusCode === 100 || statusCode === 101
                  ? 'Account is closed. Nothing can be launched.'
                  : `Account is not in a launchable state (code ${statusCode}). Fix in Ads Manager, then Refresh in the connection settings.`,
      suggestion:
        statusCode === 7
          ? 'Open Ads Manager → Account Quality → check for pending reviews. If clean, submit an appeal (a canned form; response usually 24-72h).'
          : statusCode === 3 || statusCode === 8
            ? 'Add / update funding source at business.facebook.com → Payment settings.'
            : 'Fix the underlying state in Meta before retrying.',
    });
  } else {
    findings.push({
      severity: 'ok',
      title: `Account status: ${statusLabel}`,
      detail: 'This account is in a state that permits launching.',
    });
  }

  if (disableCode !== 0) {
    findings.push({
      severity: 'error',
      title: `disable_reason: ${disableLabel} (code ${disableCode})`,
      detail:
        disableCode === 1
          ? 'Meta says the account violated their Advertising Policies. The account itself, not a specific ad.'
          : disableCode === 3
            ? "Meta's risk-scoring flagged payment activity. Usually a card-decline pattern or a card Meta doesn't trust."
            : disableCode === 4
              ? "Meta labeled the account as 'gray' — a broad restriction category applied to accounts that trip integrity signals but haven't been outright disabled."
              : `Meta's own numeric disable reason. Look up the code in Meta docs or in Account Quality.`,
      suggestion:
        'Open Ads Manager → Account Quality. Meta shows a human-readable explanation there that the API redacts.',
    });
  }

  if (isEnrolledInSpecialAdCategory) {
    findings.push({
      severity: 'warning',
      title: 'Account is enrolled in Special Ad Category enforcement',
      detail: `Meta stamped these capabilities on the account: ${sacCapabilities.join(', ')}. This forces every campaign on this account to comply with Special Ad Category rules (max age ≤65, country-only targeting, no gender, no detailed interests, Advantage+ audience only). It's the usual cause of "minimum age not allowed" errors on launch.`,
      suggestion:
        'In the launch form, set Special ad category to the matching value (or None if you think Meta flagged you incorrectly). Keep targeting country-level only, max age ≤55, Advantage+ audience on.',
    });
  }

  if (hasFundingSource === false) {
    findings.push({
      severity: 'error',
      title: 'No funding source attached',
      detail: 'Meta needs a valid payment method on the account to launch ads.',
      suggestion: 'Add a card at business.facebook.com → Payment settings.',
    });
  }

  // Phase 2: can this token list campaigns? Ultimate "can I launch?" probe.
  let canListCampaigns: boolean | null = null;
  try {
    const listUrl = `https://graph.facebook.com/${META_API_VERSION}/${input.adAccountId}/campaigns?limit=1&fields=id,name`;
    const listCtl = new AbortController();
    const listTimeout = setTimeout(() => listCtl.abort(), META_TIMEOUT_MS);
    try {
      const res = await fetch(listUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: listCtl.signal,
      });
      canListCampaigns = res.status >= 200 && res.status < 300;
      if (!canListCampaigns) {
        const errText = await res.text();
        findings.push({
          severity: 'error',
          title: 'Token cannot list campaigns on this account',
          detail: `HTTP ${res.status}. ${errText.slice(0, 400)}`,
          suggestion:
            'Regenerate the token with ads_management + ads_read scopes, then reselect the ad account in Settings → Connections → Meta.',
        });
      }
    } finally {
      clearTimeout(listTimeout);
    }
  } catch (err) {
    canListCampaigns = false;
    findings.push({
      severity: 'warning',
      title: 'Campaign-list probe failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (findings.every((f) => f.severity === 'ok' || f.severity === 'info')) {
    findings.unshift({
      severity: 'ok',
      title: 'Account is launch-ready',
      detail:
        'Meta reports the account as active, no disable reason, funding source attached, token can list campaigns. If launches still fail, the problem lives at the per-launch level (targeting / creative / budget) rather than the account itself.',
    });
  }

  return {
    ok: findings.every((f) => f.severity !== 'error'),
    adAccountId: input.adAccountId,
    accountName: acct.name ?? null,
    status: { code: statusCode, label: statusLabel, isLaunchable },
    disableReason: { code: disableCode, label: disableLabel },
    currency: acct.currency ?? null,
    timezoneName: acct.timezone_name ?? null,
    business: acct.business ?? null,
    hasFundingSource,
    isEnrolledInSpecialAdCategory,
    canListCampaigns,
    findings,
    rawResponse,
    fetchError: null,
  };
}
