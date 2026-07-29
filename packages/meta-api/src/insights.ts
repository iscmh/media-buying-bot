import { logMetaApiCall } from '@mbb/db';
import { effectiveLaunchMode, type LaunchMode } from './launch';
import { callMeta } from './client';

/**
 * Phase 5: fetch spend / impressions / clicks / conversions for a
 * single ad over a date preset. Mock mode produces deterministic-ish
 * metrics (seeded by adId) so the polling loop's decision engine can
 * exercise every kill / scale branch in dev.
 *
 * Meta's response shape:
 *   { data: [ { spend, impressions, clicks, actions: [...] } ] }
 * where `actions` contains rows like { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }.
 * We sum all conversion-flavored action_types into one `conversions` int.
 */

export interface AdInsights {
  spendUsd: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctrPct: number; // (clicks / impressions) × 100, 0 when impressions == 0
  cpcUsd: number; // spend / clicks, 0 when clicks == 0
  frequency: number; // Polish-5: average impressions per unique user, 0 when impressions == 0
  /**
   * Polish-25.7 Commit 39: sum of `action_values` for conversion-flavored
   * action_types (purchase, omni_purchase, offsite_conversion.*). USD.
   * Zero when Meta returned no value data (pixel not sending values, or
   * only non-purchase conversions like leads without a value column).
   * Dashboard falls back to `user_settings.assumed_conversion_value_usd
   * × conversions` when this is zero.
   */
  conversionValueUsd: number;
}

export interface GetAdInsightsInput {
  userId: string;
  accessToken: string;
  adId: string;
  mode: LaunchMode;
  /** Date preset in days; default 7. Meta supports 1/3/7/14/28. */
  dateRangeDays?: number;
}

export interface GetAdInsightsResult {
  ok: boolean;
  insights?: AdInsights;
  dryRun: boolean;
  errorMessage?: string;
}

const DEFAULT_DATE_PRESET = 'last_7d';

export async function getAdInsights(input: GetAdInsightsInput): Promise<GetAdInsightsResult> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const datePreset = dateRangeToPreset(input.dateRangeDays);
  // Polish-25.7 Commit 39: added `action_values` to the field list so
  // we can compute real ROAS instead of a $20/conversion heuristic.
  // Meta returns action_values with the same action_type keys as
  // `actions` but with `value` = USD amount for that conversion type.
  const endpoint = `/${input.adId}/insights?fields=spend,impressions,clicks,actions,action_values,frequency&date_preset=${datePreset}`;

  if (effective === 'mock') {
    const insights = mockInsightsFor(input.adId);
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'GET',
      requestBody: { _dry_run: true, _caller_mode: input.mode },
      responseStatus: 0,
      responseBody: { _dry_run: true, mock_insights: insights },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, insights, dryRun: true };
  }

  try {
    const result = await callMeta({
      userId: input.userId,
      endpoint,
      method: 'GET',
      accessToken: input.accessToken,
    });
    if (result.status < 200 || result.status >= 300) {
      return {
        ok: false,
        dryRun: false,
        errorMessage:
          extractMetaError(result.body) ?? `Meta /insights returned HTTP ${result.status}`,
      };
    }
    const insights = parseInsights(result.body);
    return { ok: true, insights, dryRun: false };
  } catch (err) {
    return {
      ok: false,
      dryRun: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function dateRangeToPreset(days: number | undefined): string {
  switch (days) {
    case 1:
      return 'today';
    case 3:
      return 'last_3d';
    case 14:
      return 'last_14d';
    case 28:
      return 'last_28d';
    default:
      return DEFAULT_DATE_PRESET;
  }
}

function parseInsights(body: unknown): AdInsights {
  const empty: AdInsights = {
    spendUsd: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    ctrPct: 0,
    cpcUsd: 0,
    frequency: 0,
    conversionValueUsd: 0,
  };
  if (!body || typeof body !== 'object') return empty;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return empty;
  const row = data[0] as Record<string, unknown>;

  const spendUsd = numFrom(row.spend);
  const impressions = Math.round(numFrom(row.impressions));
  const clicks = Math.round(numFrom(row.clicks));
  const conversions = sumConversionActions(row.actions);
  const conversionValueUsd = sumConversionActionValues(row.action_values);
  const frequency = numFrom(row.frequency);

  const ctrPct = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpcUsd = clicks > 0 ? spendUsd / clicks : 0;

  return {
    spendUsd,
    impressions,
    clicks,
    conversions,
    ctrPct,
    cpcUsd,
    frequency,
    conversionValueUsd,
  };
}

/**
 * Meta returns `spend` etc. as strings (the legacy "Insights returns
 * strings" quirk). Coerce defensively.
 */
function numFrom(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Sum every action_type that looks like a conversion. Pixel-tracked
 * purchases, leads, complete-registrations all count. The exhaustive
 * Meta list is long; we use a substring match on the common stems.
 */
function sumConversionActions(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const a = action as Record<string, unknown>;
    const type = typeof a.action_type === 'string' ? a.action_type : '';
    const value = numFrom(a.value);
    if (isConversionActionType(type)) {
      total += Math.round(value);
    }
  }
  return total;
}

/**
 * Polish-25.7 Commit 39: sum action_values (USD) for the same
 * conversion-flavored action_types `sumConversionActions` counts.
 * Meta returns `action_values` as an array with the same shape as
 * `actions` — `{ action_type, value }` — but `value` is the dollar
 * amount tracked for that conversion event (typically populated when
 * the pixel sends `value` on Purchase events).
 *
 * Zero when Meta returned no value data (pixel not configured to send
 * values, or only non-value conversion events like Leads without a
 * value column). Callers layer their own fallback in that case.
 */
function sumConversionActionValues(actionValues: unknown): number {
  if (!Array.isArray(actionValues)) return 0;
  let total = 0;
  for (const av of actionValues) {
    if (!av || typeof av !== 'object') continue;
    const row = av as Record<string, unknown>;
    const type = typeof row.action_type === 'string' ? row.action_type : '';
    const value = numFrom(row.value);
    if (isConversionActionType(type) && value > 0) {
      total += value;
    }
  }
  return round2(total);
}

function isConversionActionType(type: string): boolean {
  return (
    type === 'purchase' ||
    type === 'omni_purchase' ||
    type === 'lead' ||
    type === 'complete_registration' ||
    type.includes('offsite_conversion')
  );
}

function extractMetaError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: { message?: string } }).error;
  return typeof error?.message === 'string' ? error.message : undefined;
}

/**
 * Deterministic per-ad mock insights so each dev cycle a particular
 * launched_ad sees the same numbers (or a stable evolution of them).
 * Hash the adId to a fixed seed, then derive each metric. Tuned so
 * common ad ids land in different decision-engine branches in dev:
 *   - some ads spend < threshold → no_action
 *   - some spend high + 0 conv → kill rule fires
 *   - some have decent ctr + conv → scale rule fires
 */
function mockInsightsFor(adId: string): AdInsights {
  let seed = 0;
  for (let i = 0; i < adId.length; i++) {
    seed = (seed * 31 + adId.charCodeAt(i)) >>> 0;
  }
  const r1 = (seed % 100) / 100; // 0..1
  const r2 = ((seed >> 7) % 100) / 100;
  const r3 = ((seed >> 13) % 100) / 100;

  const spendUsd = round2(5 + r1 * 25); // $5..$30
  const impressions = Math.round(500 + r2 * 5000); // 500..5500
  const clicks = Math.round(impressions * (0.005 + r3 * 0.04)); // CTR 0.5%..4.5%
  const conversions = r3 > 0.7 ? Math.floor(2 + r1 * 5) : 0;
  const ctrPct = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpcUsd = clicks > 0 ? spendUsd / clicks : 0;
  // Mock frequency: 1.0..3.5 range, derived from seed for stability across runs.
  const frequency = round2(1 + r2 * 2.5);
  // Polish-25.7 Commit 39: mock conversion_value ≈ $30 per conversion
  // for dev, seeded so the same adId always renders the same value.
  const conversionValueUsd = conversions > 0 ? round2(conversions * (25 + r2 * 10)) : 0;
  return {
    spendUsd,
    impressions,
    clicks,
    conversions,
    ctrPct,
    cpcUsd,
    frequency,
    conversionValueUsd,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
