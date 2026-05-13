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
    // Phase 4b hotfix: Meta requires this flag whenever a campaign's
    // ad sets carry their own daily_budget (which is exactly our model
    // — one daily_budget per ad set). False = each ad set spends its
    // own budget independently. Without it Meta rejects the campaign
    // create with error code 100, subcode 4834011.
    is_adset_budget_sharing_enabled: false,
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

  // Phase 4b: hardcoded LINK_CLICKS — compatible with OUTCOME_TRAFFIC.
  // Settings field reserved for future per-launch picker once we support
  // more campaign objectives. Passing CONVERSIONS / etc. here against an
  // OUTCOME_TRAFFIC campaign returns HTTP 400 from Meta.
  void input.optimizationGoal;
  const body = {
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget: Math.round(input.dailyBudgetUsd * 100), // Meta wants cents
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
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
// Ad image upload (Phase 4b hotfix #2)
// =========================================================================
// Meta's /adimages endpoint accepts a multipart upload and returns a hash
// that the creative call must reference via link_data.image_hash. Trying
// to pass image_url straight into link_data — what the spec originally
// said — gets HTTP 400 / code 100 / subcode 1443050.
// =========================================================================
export interface UploadAdImageInput {
  userId: string;
  accessToken: string;
  adAccountId: string;
  /** Supabase Storage public URL for the generated variant image. */
  imageUrl: string;
  mode: LaunchMode;
  generationJobId?: string;
}

export interface UploadAdImageResult {
  ok: boolean;
  imageHash: string;
  dryRun: boolean;
  errorMessage?: string;
  metaErrorCode?: number;
}

export async function uploadAdImage(input: UploadAdImageInput): Promise<UploadAdImageResult> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/adimages`;

  if (effective === 'mock') {
    const imageHash = `dry_run_hash_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        would_upload_url: input.imageUrl,
      },
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        would_return_hash: imageHash,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, imageHash, dryRun: true };
  }

  // Live path — download the variant image from Supabase Storage, POST
  // it as multipart/form-data to Meta. Field key 'bytes' is what Meta's
  // examples use; the response keys back on the same name.
  let blob: Blob;
  try {
    const res = await fetch(input.imageUrl);
    if (!res.ok) {
      return {
        ok: false,
        imageHash: '',
        dryRun: false,
        errorMessage: `Failed to download image from ${input.imageUrl}: HTTP ${res.status}`,
      };
    }
    blob = await res.blob();
  } catch (err) {
    return {
      ok: false,
      imageHash: '',
      dryRun: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const formData = new FormData();
  // Phase 4b hotfix #3: Meta's /adimages endpoint treats the form field
  // name 'bytes' as a magic keyword that expects a base64-encoded string
  // (NOT raw binary). Sending raw PNG bytes under that key makes Meta
  // base64-decode the first few characters as garbage and reject with
  // "We couldn't process the image" (code 100, subcode 2446496).
  // Using any other field name (here: the destination filename) routes
  // the upload as a normal binary file. The response shape then keys
  // off the same name: { images: { 'creative.png': { hash, url } } }.
  const fieldName = 'creative.png';
  formData.append(fieldName, blob, fieldName);

  try {
    const result = await callMeta({
      userId: input.userId,
      endpoint,
      method: 'POST',
      formData,
      accessToken: input.accessToken,
    });
    if (result.status < 200 || result.status >= 300) {
      const { message, code } = extractMetaError(result.body);
      return {
        ok: false,
        imageHash: '',
        dryRun: false,
        errorMessage: message ?? `Meta /adimages returned HTTP ${result.status}`,
        metaErrorCode: code,
      };
    }
    const hash = extractImageHash(result.body);
    if (!hash) {
      return {
        ok: false,
        imageHash: '',
        dryRun: false,
        errorMessage: 'Meta /adimages returned 2xx but no image hash',
      };
    }
    return { ok: true, imageHash: hash, dryRun: false };
  } catch (err) {
    return {
      ok: false,
      imageHash: '',
      dryRun: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractImageHash(body: unknown): string | null {
  // Response shape: { images: { <filename>: { hash, url, ... } } }
  if (!body || typeof body !== 'object') return null;
  const images = (body as { images?: Record<string, unknown> }).images;
  if (!images || typeof images !== 'object') return null;
  for (const entry of Object.values(images)) {
    if (entry && typeof entry === 'object') {
      const hash = (entry as { hash?: unknown }).hash;
      if (typeof hash === 'string' && hash.length > 0) return hash;
    }
  }
  return null;
}

// =========================================================================
// Ad creative
// =========================================================================
export interface CreateAdCreativeInput {
  userId: string;
  accessToken: string;
  adAccountId: string;
  name: string;
  /** From uploadAdImage(). REPLACES the Phase-4b-original image_url path. */
  imageHash: string;
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
        // Phase 4b hotfix #2: Meta rejects image_url in link_data. We
        // pre-upload via /adimages first (uploadAdImage), then reference
        // the returned hash here.
        image_hash: input.imageHash,
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

// =========================================================================
// Orphan cleanup (Phase 4b hotfix #2 — part 2).
//
// When the per-variant pipeline fails AFTER createCampaign + createAdSet
// succeed (e.g. uploadAdImage rejects, createAdCreative errors), the
// campaign + ad set are left dangling on Meta. Best-effort: try to
// delete them; if cleanup itself fails, log and move on. The user's
// launched_ads row records the failure regardless.
// =========================================================================

export interface DeleteMetaObjectInput {
  userId: string;
  accessToken: string;
  /** The full Meta object id, e.g. '52552097768220'. */
  objectId: string;
  mode: LaunchMode;
  generationJobId?: string;
}

async function deleteMetaObject(
  input: DeleteMetaObjectInput,
  endpoint: string,
): Promise<{ ok: boolean; dryRun: boolean; errorMessage?: string }> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();

  if (effective === 'mock') {
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'DELETE',
      requestBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        generation_job_id: input.generationJobId ?? null,
      },
      responseStatus: 0,
      responseBody: { _dry_run: true },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, dryRun: true };
  }

  try {
    const result = await callMeta({
      userId: input.userId,
      endpoint,
      method: 'DELETE',
      accessToken: input.accessToken,
    });
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, dryRun: false };
    }
    const { message } = extractMetaError(result.body);
    return {
      ok: false,
      dryRun: false,
      errorMessage: message ?? `Meta DELETE returned HTTP ${result.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      dryRun: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteCampaign(input: DeleteMetaObjectInput) {
  return deleteMetaObject(input, `/${input.objectId}`);
}

export async function deleteAdSet(input: DeleteMetaObjectInput) {
  return deleteMetaObject(input, `/${input.objectId}`);
}
