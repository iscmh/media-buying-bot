import { randomUUID } from 'node:crypto';
import { logMetaApiCall } from '@mbb/db';
import type { MetaOptimizationGoal, MetaPlacementType } from '@mbb/shared';
import { callMeta } from './client';

/**
 * Phase 4a → 4b: mock + real Meta launch CRUD.
 *
 * Mode precedence (HARDCODED, do not relax in 4b):
 *   1. callerMode='mock'              → always mock, return dry_run id.
 *   2. callerMode='live' AND env DRY  → still mock (env override wins).
 *   3. callerMode='live' AND env LIVE → real Graph API via callMeta.
 *
 * This means setting BOT_DRY_RUN=true in dev is a hard kill switch:
 * even if the launch dialog is set to Live, no real money moves.
 *
 * HARDCODED SAFETY: every campaign + ad set + ad payload sets
 * status='PAUSED'. Cannot be overridden — the user must manually
 * activate in Meta Ads Manager. This is the safety net protecting
 * against any UI / job / DB bug from spending money unattended.
 */

export type LaunchMode = 'mock' | 'live';

function envDryRun(): boolean {
  return (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true';
}

/**
 * The effective mode honoring env override. UI passes the user's choice
 * (mock/live), env can downgrade live → mock for extra safety.
 */
export function effectiveLaunchMode(callerMode: LaunchMode): LaunchMode {
  if (callerMode === 'mock') return 'mock';
  return envDryRun() ? 'mock' : 'live';
}

function dryRunId(prefix: string): string {
  const short = randomUUID().replace(/-/g, '').slice(0, 12);
  return `dry_run_${prefix}_${short}`;
}

/** HARDCODED in Phase 4b. Never let user input override this. */
const FORCED_STATUS_PAUSED = 'PAUSED' as const;

export interface MetaCreateResult<T extends string> {
  ok: boolean;
  id: string;
  idKey: T;
  /** True when the call did NOT hit Meta (mock mode or env override). */
  dryRun: boolean;
  /** The mode the caller asked for, regardless of what actually ran. */
  callerMode: LaunchMode;
  errorMessage?: string;
  /** Meta error code if rejected at the 4xx level. */
  metaErrorCode?: number;
}

// =========================================================================
// Campaign
// =========================================================================
export interface CreateCampaignInput {
  userId: string;
  /** Phase 4b BYOC: user-side decrypted access token. Empty/'' for mock. */
  accessToken: string;
  adAccountId: string;
  name: string;
  objective: string; // e.g. 'OUTCOME_SALES' / 'OUTCOME_TRAFFIC'
  mode: LaunchMode;
  generationJobId?: string;
}

export async function createCampaign(
  input: CreateCampaignInput,
): Promise<MetaCreateResult<'campaign_id'>> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/campaigns`;
  const body = {
    name: input.name,
    objective: input.objective,
    status: FORCED_STATUS_PAUSED,
    special_ad_categories: [] as string[],
  };

  if (effective === 'mock') {
    const id = dryRunId('campaign');
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        would_return_id: id,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, id, idKey: 'campaign_id', dryRun: true, callerMode: input.mode };
  }

  return invokeMetaCreate({
    userId: input.userId,
    accessToken: input.accessToken,
    endpoint,
    body,
    callerMode: input.mode,
    idKey: 'campaign_id',
    idField: 'id',
    generationJobId: input.generationJobId,
  });
}

// =========================================================================
// Ad set
// =========================================================================
export interface CreateAdSetInput {
  userId: string;
  accessToken: string;
  adAccountId: string;
  campaignId: string;
  name: string;
  dailyBudgetUsd: number;
  optimizationGoal: MetaOptimizationGoal;
  placementType: MetaPlacementType;
  /** Phase 4b targeting overrides. */
  targetingCountries?: string[];
  ageMin?: number;
  ageMax?: number;
  mode: LaunchMode;
  generationJobId?: string;
}

export async function createAdSet(input: CreateAdSetInput): Promise<MetaCreateResult<'ad_set_id'>> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/adsets`;

  const targeting =
    input.placementType === 'advantage_plus'
      ? {
          geo_locations: { countries: input.targetingCountries ?? ['US'] },
          age_min: input.ageMin ?? 18,
          age_max: input.ageMax ?? 65,
          targeting_automation: { advantage_audience: 1 },
        }
      : {
          geo_locations: { countries: input.targetingCountries ?? ['US'] },
          age_min: input.ageMin ?? 18,
          age_max: input.ageMax ?? 65,
          facebook_positions: ['feed'],
          instagram_positions: ['stream'],
        };

  const body = {
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget: Math.round(input.dailyBudgetUsd * 100), // Meta wants cents
    billing_event: 'IMPRESSIONS',
    optimization_goal: input.optimizationGoal,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting,
    status: FORCED_STATUS_PAUSED,
  };

  if (effective === 'mock') {
    const id = dryRunId('adset');
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        would_return_id: id,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, id, idKey: 'ad_set_id', dryRun: true, callerMode: input.mode };
  }

  return invokeMetaCreate({
    userId: input.userId,
    accessToken: input.accessToken,
    endpoint,
    body,
    callerMode: input.mode,
    idKey: 'ad_set_id',
    idField: 'id',
    generationJobId: input.generationJobId,
  });
}

// =========================================================================
// Ad creative
// =========================================================================
export interface CreateAdCreativeInput {
  userId: string;
  accessToken: string;
  adAccountId: string;
  name: string;
  imageUrl: string;
  headline: string;
  primaryText: string;
  description?: string | null;
  destinationUrl: string;
  pageId: string;
  mode: LaunchMode;
  generationJobId?: string;
}

export async function createAdCreative(
  input: CreateAdCreativeInput,
): Promise<MetaCreateResult<'creative_id'>> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/adcreatives`;
  const body = {
    name: input.name,
    object_story_spec: {
      page_id: input.pageId,
      link_data: {
        image_url: input.imageUrl,
        link: input.destinationUrl,
        message: input.primaryText,
        name: input.headline,
        description: input.description ?? undefined,
        call_to_action: { type: 'LEARN_MORE' },
      },
    },
  };

  if (effective === 'mock') {
    const id = dryRunId('creative');
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        would_return_id: id,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, id, idKey: 'creative_id', dryRun: true, callerMode: input.mode };
  }

  return invokeMetaCreate({
    userId: input.userId,
    accessToken: input.accessToken,
    endpoint,
    body,
    callerMode: input.mode,
    idKey: 'creative_id',
    idField: 'id',
    generationJobId: input.generationJobId,
  });
}

// =========================================================================
// Ad
// =========================================================================
export interface CreateAdInput {
  userId: string;
  accessToken: string;
  adAccountId: string;
  adSetId: string;
  creativeId: string;
  name: string;
  mode: LaunchMode;
  generationJobId?: string;
}

export async function createAd(input: CreateAdInput): Promise<MetaCreateResult<'ad_id'>> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/ads`;
  const body = {
    name: input.name,
    adset_id: input.adSetId,
    creative: { creative_id: input.creativeId },
    status: FORCED_STATUS_PAUSED,
  };

  if (effective === 'mock') {
    const id = dryRunId('ad');
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        would_return_id: id,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, id, idKey: 'ad_id', dryRun: true, callerMode: input.mode };
  }

  return invokeMetaCreate({
    userId: input.userId,
    accessToken: input.accessToken,
    endpoint,
    body,
    callerMode: input.mode,
    idKey: 'ad_id',
    idField: 'id',
    generationJobId: input.generationJobId,
  });
}

// =========================================================================
// Shared live-path invoker. Wraps callMeta and unwraps the response to the
// MetaCreateResult contract every caller expects.
// =========================================================================
async function invokeMetaCreate<T extends string>(input: {
  userId: string;
  accessToken: string;
  endpoint: string;
  body: Record<string, unknown>;
  callerMode: LaunchMode;
  idKey: T;
  idField: string;
  generationJobId?: string;
}): Promise<MetaCreateResult<T>> {
  try {
    const result = await callMeta({
      userId: input.userId,
      endpoint: input.endpoint,
      method: 'POST',
      body: input.body,
      accessToken: input.accessToken,
    });

    // Graph API returns 200 with the new object's id on success; 4xx +
    // structured `error: { message, code }` on rejection. Treat anything
    // other than 200..299 as a failed create.
    if (result.status >= 200 && result.status < 300) {
      const id = extractId(result.body, input.idField);
      if (!id) {
        return {
          ok: false,
          id: '',
          idKey: input.idKey,
          dryRun: false,
          callerMode: input.callerMode,
          errorMessage: 'Meta returned 2xx but no id field',
        };
      }
      return { ok: true, id, idKey: input.idKey, dryRun: false, callerMode: input.callerMode };
    }

    const { message, code } = extractMetaError(result.body);
    return {
      ok: false,
      id: '',
      idKey: input.idKey,
      dryRun: false,
      callerMode: input.callerMode,
      errorMessage: message ?? `Meta returned HTTP ${result.status}`,
      metaErrorCode: code,
    };
  } catch (err) {
    return {
      ok: false,
      id: '',
      idKey: input.idKey,
      dryRun: false,
      callerMode: input.callerMode,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractId(body: unknown, idField: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const v = (body as Record<string, unknown>)[idField];
  return typeof v === 'string' ? v : null;
}

function extractMetaError(body: unknown): { message?: string; code?: number } {
  if (!body || typeof body !== 'object') return {};
  const error = (body as { error?: { message?: string; code?: number } }).error;
  if (!error) return {};
  return { message: error.message, code: error.code };
}
