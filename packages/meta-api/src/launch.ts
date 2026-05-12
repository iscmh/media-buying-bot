import { randomUUID } from 'node:crypto';
import { logMetaApiCall } from '@mbb/db';
import type { MetaOptimizationGoal, MetaPlacementType } from '@mbb/shared';

/**
 * Phase 4a: mock Meta launch CRUD. Every function honors BOT_DRY_RUN —
 * when true (default), no network call is made; instead the payload
 * that WOULD have been sent is audit-logged and a dry-run placeholder
 * ID is returned. Phase 4b will replace the dry-run branch with calls
 * through callMeta to graph.facebook.com.
 *
 * Keep this file's API stable — the Inngest launch job calls these in
 * a fixed sequence (campaign → ad set → creative → ad). When real Meta
 * support lands, only the body of each function changes.
 */

function isDryRun(): boolean {
  return (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true';
}

function dryRunId(prefix: string): string {
  // Short uuid (12 chars of hex) keeps logs readable while still unique.
  const short = randomUUID().replace(/-/g, '').slice(0, 12);
  return `dry_run_${prefix}_${short}`;
}

export interface CreateCampaignInput {
  userId: string;
  adAccountId: string;
  name: string;
  objective: string; // e.g. 'OUTCOME_SALES'
  /** Optional context for downstream linking; just logged in 4a. */
  generationJobId?: string;
}

export interface MetaCreateResult<T extends string> {
  ok: boolean;
  /** Property name varies (`campaign_id` / `ad_set_id` / etc) — discriminator on T. */
  id: string;
  idKey: T;
  dryRun: boolean;
  errorMessage?: string;
}

/**
 * Phase 4a mock createCampaign. Always succeeds in DRY_RUN mode and
 * returns a dry_run_campaign_<short-uuid> id. Phase 4b will issue
 * `POST /act_<id>/campaigns` via callMeta.
 */
export async function createCampaign(
  input: CreateCampaignInput,
): Promise<MetaCreateResult<'campaign_id'>> {
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/campaigns`;
  const body = {
    name: input.name,
    objective: input.objective,
    status: 'PAUSED',
    special_ad_categories: [],
  };
  if (isDryRun()) {
    const id = dryRunId('campaign');
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        would_return_id: id,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, id, idKey: 'campaign_id', dryRun: true };
  }
  throw new Error('createCampaign live mode not implemented — Phase 4b.');
}

export interface CreateAdSetInput {
  userId: string;
  adAccountId: string;
  campaignId: string;
  name: string;
  dailyBudgetUsd: number;
  optimizationGoal: MetaOptimizationGoal;
  placementType: MetaPlacementType;
  generationJobId?: string;
}

export async function createAdSet(input: CreateAdSetInput): Promise<MetaCreateResult<'ad_set_id'>> {
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/adsets`;
  // Meta expects daily_budget in minor units (cents for USD).
  const body = {
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget: Math.round(input.dailyBudgetUsd * 100),
    billing_event: 'IMPRESSIONS',
    optimization_goal: input.optimizationGoal,
    targeting:
      input.placementType === 'advantage_plus'
        ? { targeting_automation: { advantage_audience: 1 } }
        : { geo_locations: { countries: ['US'] } },
    status: 'PAUSED',
  };
  if (isDryRun()) {
    const id = dryRunId('adset');
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        would_return_id: id,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, id, idKey: 'ad_set_id', dryRun: true };
  }
  throw new Error('createAdSet live mode not implemented — Phase 4b.');
}

export interface CreateAdCreativeInput {
  userId: string;
  adAccountId: string;
  name: string;
  imageUrl: string;
  headline: string;
  primaryText: string;
  description?: string | null;
  destinationUrl: string;
  pageId: string;
  generationJobId?: string;
}

export async function createAdCreative(
  input: CreateAdCreativeInput,
): Promise<MetaCreateResult<'creative_id'>> {
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
      },
    },
  };
  if (isDryRun()) {
    const id = dryRunId('creative');
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        would_return_id: id,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, id, idKey: 'creative_id', dryRun: true };
  }
  throw new Error('createAdCreative live mode not implemented — Phase 4b.');
}

export interface CreateAdInput {
  userId: string;
  adAccountId: string;
  adSetId: string;
  creativeId: string;
  name: string;
  generationJobId?: string;
}

export async function createAd(input: CreateAdInput): Promise<MetaCreateResult<'ad_id'>> {
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/ads`;
  const body = {
    name: input.name,
    adset_id: input.adSetId,
    creative: { creative_id: input.creativeId },
    status: 'PAUSED',
  };
  if (isDryRun()) {
    const id = dryRunId('ad');
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        would_return_id: id,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, id, idKey: 'ad_id', dryRun: true };
  }
  throw new Error('createAd live mode not implemented — Phase 4b.');
}
