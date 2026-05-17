import { randomUUID } from 'node:crypto';
import { logMetaApiCall } from '@mbb/db';
import type { MetaOptimizationGoal, MetaPlacementType } from '@mbb/shared';
import { checkBudgetMeetsMetaMinimum } from '@mbb/shared';
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
 *
 * Polish-3.6: creative builder is now content-type aware.
 *
 * Audit of the old path (which broke Denis's UGC launch):
 *   For every variant — image OR video — the worker called
 *   uploadAdImage(variant.fileUrl) → /act_<id>/adimages, then built a
 *   creative with link_data.image_hash. Meta's /adimages endpoint
 *   rejects MP4 binaries; the response in Romanian read "Tipul de
 *   imagine folosit nu este acceptat" ("Unsupported image type").
 *
 * New control flow (createAdCreative now dispatches on `media`):
 *   - media={ kind: 'image', imageHash }:
 *         POST /adimages → hash → link_data.image_hash       (existing)
 *   - media={ kind: 'video', videoId, thumbnailUrl }:
 *         POST /advideos → video_id (async-processed)
 *         poll GET /<video_id>?fields=status until ready
 *         fetch /<video_id>/thumbnails → preferred image_url
 *         build creative with video_data { video_id, image_url,
 *         call_to_action, message, link_description }
 *
 * The worker (meta-ad-launcher.ts) is responsible for inspecting
 * variant.fileUrl + concept.contentType, picking the right pre-upload
 * helper (uploadAdImage vs uploadAdVideo + pollMetaVideoReady +
 * fetchMetaVideoThumbnail), and passing the corresponding `media`
 * discriminator down.
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
  /**
   * Polish-3.5: full Meta API response body (success or failure). The
   * launcher persists this on launched_ads.meta_response_raw so the UI
   * can surface error_user_msg / error_subcode / fbtrace_id instead of
   * the generic "Invalid parameter" rollup.
   */
  rawResponse?: unknown;
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
  /**
   * Polish-3.5: ISO currency the ad account is denominated in. Drives
   * USD→account-currency conversion before computing daily_budget in
   * minor units. Defaults to USD when unknown.
   */
  accountCurrency?: string;
  /** Per-account override for Meta's minimum daily budget (minor units). */
  minDailyBudgetMinor?: number | null;
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

  // Polish-3.5: Meta's daily_budget is in the ad account's currency, in
  // MINOR units. Default to USD-cents when no currency is supplied so
  // existing callers keep working. Pre-flight against the account's
  // minimum daily budget — failing here surfaces a clear, actionable
  // error instead of Meta's generic "Invalid parameter" 4xx.
  const currency = input.accountCurrency ?? 'USD';
  const budgetCheck = checkBudgetMeetsMetaMinimum({
    usdAmount: input.dailyBudgetUsd,
    currency,
    connectionMin: input.minDailyBudgetMinor ?? null,
  });
  if (!budgetCheck.ok) {
    return {
      ok: false,
      id: '',
      idKey: 'ad_set_id' as const,
      dryRun: false,
      callerMode: input.mode,
      errorMessage: budgetCheck.reason,
    };
  }
  const dailyBudgetMinor = budgetCheck.minor;

  const body = {
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget: dailyBudgetMinor,
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
// Ad video upload (Polish-3.6)
// =========================================================================
// Meta's /advideos endpoint takes a file_url (or a multipart upload) and
// returns a video_id. Videos are processed asynchronously — pollMeta
// VideoReady waits for status.video_status === 'ready' before letting
// the creative call go through. After processing, fetchMetaVideoThumbnail
// pulls a preferred thumbnail uri to satisfy the creative's required
// image_url field on video_data.
//
// Endpoint host note: video uploads go to graph-video.facebook.com
// (NOT graph.facebook.com) per Meta's docs. We POST file_url with no
// multipart so Meta does the fetch — works for any publicly-resolvable
// URL including Supabase signed URLs.
// =========================================================================

const GRAPH_VIDEO_BASE = 'https://graph-video.facebook.com';
const META_API_VERSION = process.env.META_API_VERSION ?? 'v21.0';

export interface UploadAdVideoInput {
  userId: string;
  accessToken: string;
  adAccountId: string;
  /** Public URL Meta can fetch (Supabase signed URL or HeyGen CDN URL). */
  videoUrl: string;
  mode: LaunchMode;
  generationJobId?: string;
}

export interface UploadAdVideoResult {
  ok: boolean;
  /** Meta video id. dry_run_video_* in mock mode. */
  videoId: string;
  dryRun: boolean;
  errorMessage?: string;
  metaErrorCode?: number;
}

export async function uploadAdVideo(input: UploadAdVideoInput): Promise<UploadAdVideoResult> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const endpoint = `/${input.adAccountId}/advideos`;

  if (effective === 'mock') {
    const videoId = `dry_run_video_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        would_upload_url: input.videoUrl,
      },
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        would_return_video_id: videoId,
        generation_job_id: input.generationJobId ?? null,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, videoId, dryRun: true };
  }

  // Live: hit graph-video.facebook.com (NOT graph.facebook.com). file_url
  // tells Meta to fetch the video itself, which works for any publicly
  // resolvable URL including Supabase signed URLs (~1h validity).
  const url = `${GRAPH_VIDEO_BASE}/${META_API_VERSION}${endpoint}`;
  const form = new URLSearchParams();
  form.set('file_url', input.videoUrl);
  form.set('access_token', input.accessToken);

  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    body = { _fetch_error: err instanceof Error ? err.message : String(err) };
  } finally {
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: { file_url: input.videoUrl },
      responseStatus: status,
      responseBody: body,
      latencyMs: Date.now() - t0,
      dryRun: false,
    });
  }

  if (status >= 200 && status < 300 && body && typeof body === 'object' && 'id' in body) {
    return {
      ok: true,
      videoId: String((body as { id: unknown }).id),
      dryRun: false,
    };
  }
  const { message, code } = extractMetaError(body);
  return {
    ok: false,
    videoId: '',
    dryRun: false,
    errorMessage: message ?? `Meta /advideos returned HTTP ${status}`,
    metaErrorCode: code,
  };
}

export interface PollMetaVideoReadyInput {
  userId: string;
  accessToken: string;
  videoId: string;
  /** Defaults to 60s. Meta typically finishes processing in 10-30s. */
  timeoutMs?: number;
  /** Poll cadence. Defaults to 2s. */
  intervalMs?: number;
}

export interface PollMetaVideoReadyResult {
  ok: boolean;
  status?: string;
  errorMessage?: string;
}

/**
 * Poll a video's processing status until `video_status === 'ready'` or
 * the deadline elapses. Returns ok=false on timeout / error / FAILED.
 */
export async function pollMetaVideoReady(
  input: PollMetaVideoReadyInput,
): Promise<PollMetaVideoReadyResult> {
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  const intervalMs = input.intervalMs ?? 2_000;
  let lastStatus: string | undefined;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${input.videoId}?fields=status&access_token=${encodeURIComponent(input.accessToken)}`,
        { method: 'GET' },
      );
    } catch (err) {
      return {
        ok: false,
        errorMessage: `Video status poll failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!res.ok) {
      // 4xx during poll is fatal (video disappeared, bad token).
      return { ok: false, errorMessage: `Video status poll HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      status?: { video_status?: string };
    };
    const videoStatus = body.status?.video_status;
    lastStatus = videoStatus;
    if (videoStatus === 'ready') {
      return { ok: true, status: videoStatus };
    }
    if (videoStatus === 'error' || videoStatus === 'expired') {
      return {
        ok: false,
        status: videoStatus,
        errorMessage: `Meta reported video_status=${videoStatus}`,
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    status: lastStatus,
    errorMessage: `Video did not finish processing within ${(input.timeoutMs ?? 60_000) / 1000}s.`,
  };
}

export interface FetchMetaVideoThumbnailInput {
  userId: string;
  accessToken: string;
  videoId: string;
}

export interface FetchMetaVideoThumbnailResult {
  ok: boolean;
  thumbnailUrl?: string;
  errorMessage?: string;
}

/**
 * Pull the preferred thumbnail uri for an uploaded video. Required by
 * the creative call — Meta wants an image_url on video_data even though
 * it ALSO has the video itself.
 */
export async function fetchMetaVideoThumbnail(
  input: FetchMetaVideoThumbnailInput,
): Promise<FetchMetaVideoThumbnailResult> {
  let res: Response;
  try {
    res = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${input.videoId}/thumbnails?fields=uri,is_preferred&access_token=${encodeURIComponent(input.accessToken)}`,
      { method: 'GET' },
    );
  } catch (err) {
    return {
      ok: false,
      errorMessage: `Thumbnail fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    return { ok: false, errorMessage: `Thumbnail fetch HTTP ${res.status}` };
  }
  const body = (await res.json().catch(() => ({}))) as {
    data?: Array<{ uri?: string; is_preferred?: boolean }>;
  };
  const thumbs = body.data ?? [];
  if (thumbs.length === 0) {
    return { ok: false, errorMessage: 'Meta returned no thumbnails for video.' };
  }
  const preferred = thumbs.find((t) => t.is_preferred) ?? thumbs[0];
  if (!preferred?.uri) {
    return { ok: false, errorMessage: 'Meta thumbnail entry has no uri.' };
  }
  return { ok: true, thumbnailUrl: preferred.uri };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =========================================================================
// Ad creative
// =========================================================================
/**
 * Polish-3.6 discriminated media payload. Image variants reach Meta via
 * link_data.image_hash; video variants reach it via video_data
 * { video_id, image_url }.
 */
export type CreativeMedia =
  | { kind: 'image'; imageHash: string }
  | { kind: 'video'; videoId: string; thumbnailUrl: string };

export interface CreateAdCreativeInput {
  userId: string;
  accessToken: string;
  adAccountId: string;
  name: string;
  /** Polish-3.6: image vs video. Old callers can keep passing imageHash. */
  media?: CreativeMedia;
  /** Deprecated — pass via media={kind:'image',imageHash} instead. */
  imageHash?: string;
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

  // Polish-3.6: normalize the back-compat shape. Old callers pass
  // imageHash directly; new callers pass media. Internally we always
  // operate on the discriminated CreativeMedia.
  const media: CreativeMedia =
    input.media ??
    (input.imageHash
      ? { kind: 'image', imageHash: input.imageHash }
      : { kind: 'image', imageHash: '' });

  // Image vs video diverge on object_story_spec content.
  //   Image: link_data.image_hash (Phase-4b hotfix #2 — Meta rejects
  //          image_url here, must pre-upload via /adimages).
  //   Video: video_data { video_id, image_url, call_to_action,
  //          link_description }. image_url is the thumbnail.
  let objectStorySpec: Record<string, unknown>;
  if (media.kind === 'image') {
    objectStorySpec = {
      page_id: input.pageId,
      link_data: {
        image_hash: media.imageHash,
        link: input.destinationUrl,
        message: input.primaryText,
        name: input.headline,
        description: input.description ?? undefined,
        call_to_action: { type: 'LEARN_MORE' },
      },
    };
  } else {
    objectStorySpec = {
      page_id: input.pageId,
      video_data: {
        video_id: media.videoId,
        // Required by Meta — the still frame shown before play starts.
        image_url: media.thumbnailUrl,
        message: input.primaryText,
        title: input.headline,
        link_description: input.description ?? undefined,
        call_to_action: {
          type: 'LEARN_MORE',
          // Video CTAs need link.value on the call_to_action itself, not
          // on a sibling link field like link_data has.
          value: { link: input.destinationUrl },
        },
      },
    };
  }

  const body = {
    name: input.name,
    object_story_spec: objectStorySpec,
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
          rawResponse: result.body,
        };
      }
      return {
        ok: true,
        id,
        idKey: input.idKey,
        dryRun: false,
        callerMode: input.callerMode,
        rawResponse: result.body,
      };
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
      rawResponse: result.body,
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
  const error = (
    body as {
      error?: {
        message?: string;
        code?: number;
        error_user_msg?: string;
        error_user_title?: string;
      };
    }
  ).error;
  if (!error) return {};
  // Polish-3.5: prefer error_user_msg / error_user_title when Meta provides
  // them — they're the actionable copy ("This page can't be used for ads
  // because…") vs. the generic "Invalid parameter" Meta returns in
  // error.message for most 4xx failures.
  const friendly = error.error_user_msg ?? error.error_user_title;
  return { message: friendly ?? error.message, code: error.code };
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
