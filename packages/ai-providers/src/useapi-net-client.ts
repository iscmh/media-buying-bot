/**
 * Polish-29.0.0 Commit 110: useapi.net client wrapper.
 *
 * useapi.net is the shared arbitrage layer that gets us cheaper access
 * to the video/image models we bill through credits. One bearer token
 * (USEAPI_NET_API_TOKEN) unlocks every downstream service — we then
 * register per-service accounts (Google Flow, Dreamina, Kling, etc.)
 * against that token by POSTing to the per-service /accounts endpoint
 * with the credentials the docs specify (cookies, email+password, ...).
 *
 * Two services shipped in this commit:
 *   - Google Flow  (Veo 3 Fast, Nano Banana images)  — cookie-based
 *   - Dreamina     (Seedance 2.5 / 2.0 video, Seedream images)
 *                                                     — email + password
 *
 * The remaining useapi.net services (Kling, Runway, PixVerse, MiniMax)
 * follow the same shape; they'll drop in as we register accounts.
 *
 * ## Auth model
 *
 * ONE server-side bearer token authenticates every call:
 *   Authorization: Bearer ${process.env.USEAPI_NET_API_TOKEN}
 *
 * Individual user AI-service accounts are registered against that
 * token via POST /:service/accounts. Registered accounts show up in
 * subsequent job submissions with the account email/id.
 *
 * ## Job model
 *
 * Every video/image submission is async:
 *   1. POST /:service/videos (or /images) → 200 with { jobid, ... }
 *   2. GET  /:service/jobs/:jobid until status is 'completed' | 'failed'
 *   3. Read result URL from the completed job payload.
 *
 * Sleep between polls; the shared `checkUseapiJob` helper does one
 * check and the caller composes with Inngest `step.sleep`.
 *
 * ## Error surface
 *
 * Uses the shared `callProvider` chokepoint so every call is audit-
 * logged and timeout-guarded uniformly with the rest of the AI stack.
 * The bearer token is passed as a Header only — never persisted, never
 * echoed back in logs.
 */

import { callProvider } from './chokepoint';

const USEAPI_BASE = 'https://api.useapi.net/v1';
const SUBMIT_TIMEOUT_MS = 45_000;
const POLL_TIMEOUT_MS = 20_000;
const ACCOUNTS_TIMEOUT_MS = 30_000;
// Polish-29.0.25 Commit 134: Dreamina character-PNG upload hit the
// 60s timeout on 29.0.24. Nano Banana Pro output is ~500KB-2MB PNG;
// useapi.net's Dreamina proxy needs to hand-off to ByteDance CDN which
// sometimes stalls under load. Bump to 3 min — well under Vercel's
// serverless 15 min ceiling.
const UPLOAD_TIMEOUT_MS = 180_000;

// -----------------------------------------------------------------
// Token resolver
// -----------------------------------------------------------------

/**
 * Server-only bearer token. Not exposed to the browser. `credits.ts`
 * gates on the presence of the env var — a missing token means we
 * refuse to reserve credits for a useapi.net-backed model, so callers
 * always know before draining balance.
 */
export function getUseapiNetToken(): string {
  const t = process.env['USEAPI_NET_API_TOKEN'];
  if (!t) {
    throw new UseapiNetConfigError(
      'USEAPI_NET_API_TOKEN is not set. Add it to the environment (Vercel + .env.local) before invoking credit-backed models.',
    );
  }
  return t;
}

export function isUseapiNetConfigured(): boolean {
  return Boolean(process.env['USEAPI_NET_API_TOKEN']);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getUseapiNetToken()}`,
    'content-type': 'application/json',
  };
}

// -----------------------------------------------------------------
// Errors
// -----------------------------------------------------------------

export class UseapiNetConfigError extends Error {
  readonly kind = 'useapi_net_config' as const;
}

export class UseapiNetAccountError extends Error {
  readonly kind = 'useapi_net_account' as const;
  constructor(
    public service: UseapiService,
    message: string,
  ) {
    super(message);
  }
}

export class UseapiNetJobError extends Error {
  readonly kind = 'useapi_net_job' as const;
  constructor(
    public service: UseapiService,
    public jobId: string | null,
    message: string,
  ) {
    super(message);
  }
}

// -----------------------------------------------------------------
// Shared job status shape
// -----------------------------------------------------------------

/**
 * useapi.net normalizes job status to these three buckets across every
 * service. Individual services expose a raw upstream string too — we
 * surface it in `rawStatus` for diagnostics but branch on `status`.
 */
export type UseapiJobStatus = 'processing' | 'completed' | 'failed';

export interface UseapiJobResult {
  status: UseapiJobStatus;
  rawStatus: string | null;
  /** For video results. */
  videoUrl?: string;
  /** For image results (or a still exported from a video job). */
  imageUrls?: string[];
  /** Any error the upstream service surfaced. */
  errorMessage?: string;
  /** Raw job body, useful when debugging a shape mismatch. */
  raw: Record<string, unknown>;
}

export type UseapiService =
  | 'google-flow'
  | 'dreamina'
  | 'kling'
  | 'runway'
  | 'pixverse'
  | 'minimax';

// -----------------------------------------------------------------
// Account registration
// -----------------------------------------------------------------

/**
 * Google Flow requires a browser-derived cookie header (login state
 * for the underlying Google account). Recommended flow per useapi.net:
 * open a fresh Chromium profile, log in, copy the cookies from
 * DevTools, POST them here.
 */
export interface GoogleFlowAccountInput {
  /** Cookie header string exactly as copied from DevTools → Application. */
  cookieHeader: string;
  /** Optional label for multi-account rotation. */
  label?: string;
}

/**
 * Dreamina uses email + password directly (no browser cookies). Server-
 * side login happens on useapi.net's infrastructure; region matters
 * because model availability differs (CA gets 1080p/4K, US doesn't).
 */
export interface DreaminaAccountInput {
  email: string;
  password: string;
  region: 'us' | 'ca';
  label?: string;
}

export interface RegisterAccountResult {
  ok: boolean;
  accountId?: string;
  errorMessage?: string;
}

/**
 * Register a Google Flow account against the shared bearer token.
 * Idempotent by cookie value on useapi.net's side; a second POST with
 * the same cookies just updates the existing row.
 */
export async function registerGoogleFlowAccount(input: {
  userId: string;
  account: GoogleFlowAccountInput;
}): Promise<RegisterAccountResult> {
  const result = await callProvider<{ accountId?: string; account?: { id?: string } }>({
    userId: input.userId,
    provider: 'useapi_net',
    url: `${USEAPI_BASE}/google-flow/accounts`,
    method: 'POST',
    headers: authHeaders(),
    body: {
      cookies: input.account.cookieHeader,
      label: input.account.label,
    },
    // Do NOT log the cookie header — it's a session credential.
    requestBodyForLog: {
      label: input.account.label ?? null,
      cookie_len: input.account.cookieHeader.length,
    },
    timeoutMs: ACCOUNTS_TIMEOUT_MS,
  });

  if (!result.ok) {
    return { ok: false, errorMessage: result.errorMessage };
  }
  const id = result.data.accountId ?? result.data.account?.id;
  return { ok: true, accountId: id };
}

/**
 * Polish-29.0.30 Commit 139: fetch a registered Dreamina account's
 * current credit balance from useapi.net. Used as a pre-flight check
 * in the polish29 seedance variations worker to fail fast when the
 * account is dry — before we spend Claude + Nano Banana BYOK $$ on a
 * generation that will die at the first Seedance submit with ret:1006
 * "Not enough credits". Returns { ok:false } for network errors or if
 * useapi.net doesn't recognize the account.
 */
export interface DreaminaAccountBalance {
  ok: true;
  totalCredits: number;
  vipCredits: number;
  giftCredits: number;
  purchaseCredits: number;
  region: 'US' | 'CA' | string;
}
export type GetDreaminaAccountResult = DreaminaAccountBalance | { ok: false; errorMessage: string };
export async function getDreaminaAccountBalance(input: {
  userId: string;
  account: string;
}): Promise<GetDreaminaAccountResult> {
  const url = `${USEAPI_BASE}/dreamina/accounts/${encodeURIComponent(input.account)}`;
  const result = await callProvider<{
    account?: string;
    region?: string;
    credits?: { total?: number; vip?: number; gift?: number; purchase?: number };
  }>({
    userId: input.userId,
    provider: 'useapi_net',
    url,
    method: 'GET',
    headers: authHeaders(),
    timeoutMs: ACCOUNTS_TIMEOUT_MS,
    requestBodyForLog: { account_hash: hashAccount(input.account) },
  });
  if (!result.ok) {
    return { ok: false, errorMessage: result.errorMessage ?? `HTTP ${result.status}` };
  }
  const c = result.data.credits ?? {};
  return {
    ok: true,
    totalCredits: c.total ?? 0,
    vipCredits: c.vip ?? 0,
    giftCredits: c.gift ?? 0,
    purchaseCredits: c.purchase ?? 0,
    region: result.data.region ?? 'unknown',
  };
}

export async function registerDreaminaAccount(input: {
  userId: string;
  account: DreaminaAccountInput;
}): Promise<RegisterAccountResult> {
  const result = await callProvider<{ accountId?: string; account?: { id?: string } }>({
    userId: input.userId,
    provider: 'useapi_net',
    url: `${USEAPI_BASE}/dreamina/accounts`,
    method: 'POST',
    headers: authHeaders(),
    body: {
      email: input.account.email,
      password: input.account.password,
      region: input.account.region,
      label: input.account.label,
    },
    // Do NOT log the password.
    requestBodyForLog: {
      email: input.account.email,
      region: input.account.region,
      label: input.account.label ?? null,
    },
    timeoutMs: ACCOUNTS_TIMEOUT_MS,
  });

  if (!result.ok) {
    return { ok: false, errorMessage: result.errorMessage };
  }
  const id = result.data.accountId ?? result.data.account?.id;
  return { ok: true, accountId: id };
}

// -----------------------------------------------------------------
// Asset upload (reference images for image-to-video / character clone)
// -----------------------------------------------------------------

export interface UploadAssetInput {
  userId: string;
  service: 'google-flow' | 'dreamina';
  /** Raw bytes of the image. */
  bytes: Uint8Array;
  /** Content-Type of the uploaded asset. */
  contentType: string;
  /** File name hint (some services key their asset browser on this). */
  filename?: string;
  /**
   * Polish-29.0.19 Commit 128: Dreamina's docs list POST /dreamina/
   * assets/account — the trailing `account` is a URL placeholder for
   * the specific registered account email, NOT a literal string.
   * Without it useapi.net answers "Unable to find configuration for
   * account account". Required for the dreamina service; ignored
   * (currently) for google-flow.
   */
  account?: string;
}

export interface UploadAssetResult {
  ok: boolean;
  assetId?: string;
  assetUrl?: string;
  errorMessage?: string;
}

/**
 * Upload a reference image to a service. Returns an asset id the video
 * / image endpoints reference in their submission body. Direct fetch
 * (not `callProvider`) because the body is binary — the chokepoint's
 * JSON path doesn't fit multipart. Timing + status still audit-logged
 * inline.
 *
 * Polish-29.0.17 Commit 126: the Dreamina asset upload endpoint is
 * /dreamina/assets/account (per docs), not /dreamina/assets. google-flow
 * remains on /assets (matches its docs). Response for Dreamina is an
 * imageRef string like "CA:user@example.com-image:w685:h900:s86866-
 * uri:tos-useast5-i-wopfjsm1ax-tx/abc123" which is what the video
 * submit body wants under firstFrameRef.
 */
export async function uploadUseapiAsset(input: UploadAssetInput): Promise<UploadAssetResult> {
  if (input.service === 'dreamina' && !input.account) {
    return {
      ok: false,
      errorMessage:
        'Dreamina asset upload requires `account` (registered Dreamina email). ' +
        'The URL path takes the account as its last segment.',
    };
  }
  const url =
    input.service === 'dreamina'
      ? `${USEAPI_BASE}/dreamina/assets/${encodeURIComponent(input.account!)}`
      : `${USEAPI_BASE}/${input.service}/assets`;
  const t0 = Date.now();
  try {
    // Polish-29.0.18 Commit 127: Dreamina's /assets/account rejected
    // multipart with "Content-Type (multipart/form-data) not supported.
    // Valid values: image/jpeg, image/png, image/webp, video/mp4, ...".
    // It wants raw bytes with the media mime as the Content-Type.
    // google-flow's /assets endpoint historically wants multipart, so
    // branch on service. If google-flow ever ships the same raw-body
    // change, we'll flip it too.
    const useRawBody = input.service === 'dreamina';
    // Copy through a plain ArrayBuffer so Node's fetch always accepts
    // the buffer (Uint8Array over SharedArrayBuffer isn't a BlobPart
    // in TS's stricter DOM typings).
    const ab = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(ab).set(input.bytes);

    let requestBody: ArrayBuffer | FormData;
    let extraHeaders: Record<string, string>;
    if (useRawBody) {
      requestBody = ab;
      extraHeaders = { 'Content-Type': input.contentType };
    } else {
      const form = new FormData();
      const blob = new Blob([ab], { type: input.contentType });
      form.append('file', blob, input.filename ?? 'reference.bin');
      requestBody = form;
      // Do NOT set content-type — fetch adds the multipart boundary
      // when it sees a FormData body.
      extraHeaders = {};
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getUseapiNetToken()}`,
        ...extraHeaders,
      },
      body: requestBody,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { _non_json_body: text.slice(0, 4096) };
    }

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        errorMessage: extractError(parsed) ?? `Upload failed with HTTP ${res.status}`,
      };
    }
    const body = (parsed ?? {}) as {
      assetId?: string;
      // Polish-29.0.17 Commit 126: Dreamina's asset upload returns
      // `imageRef` at the top level (per docs), not `assetId`. Accept
      // either — the video submit's firstFrameRef param takes whichever
      // string was returned.
      imageRef?: string;
      url?: string;
      asset?: { id?: string; url?: string; imageRef?: string };
    };
    const assetId = body.assetId ?? body.imageRef ?? body.asset?.id ?? body.asset?.imageRef;
    const assetUrl = body.url ?? body.asset?.url;
    if (!assetId && !assetUrl) {
      return {
        ok: false,
        errorMessage: `Upload response contained no asset id or url (${latencyMs}ms). Raw: ${JSON.stringify(body).slice(0, 300)}`,
      };
    }
    return { ok: true, assetId, assetUrl };
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// -----------------------------------------------------------------
// Job polling (shared across services)
// -----------------------------------------------------------------

export interface CheckJobInput {
  userId: string;
  service: UseapiService;
  jobId: string;
  /**
   * Polish-29.0.43 Commit 152 tried to route google-flow image polls
   * to /google-flow/images/{jobid} — turned out to be a wrong guess.
   * The real root cause (fixed in Commit 153) was the jobid being
   * URL-encoded before it hit the router. Field kept on the type as
   * an inert breadcrumb so a future refactor doesn't reintroduce the
   * mistake and to avoid a call-site diff at the polish30 site.
   */
  resourceKind?: 'video' | 'image';
  generationJobId?: string;
  generatedCreativeId?: string;
}

/**
 * Poll a single useapi.net job. Callers compose with Inngest
 * `step.sleep` between polls; this function does one status check
 * only. Returns `processing` while upstream keeps grinding.
 *
 * Polish-29.0.20 Commit 129: Dreamina's poll endpoint is
 * /dreamina/videos/{jobid} (per docs), NOT /dreamina/jobs/{jobid}.
 * Live 29.0.19 run advanced all the way to poll and hit HTTP 404
 * because the /jobs/ path 404s on Dreamina. google-flow's docs list
 * a dedicated GET /jobs/{jobid} endpoint so keep it on /jobs. Branch
 * by service.
 *
 * Polish-29.0.44 Commit 153: google-flow image polls ALSO go to
 * /google-flow/jobs/{jobid}, same as video — Commit 152's split-by-
 * resource-kind guess was wrong (useapi returned "Wrong GET url" for
 * /google-flow/images/{jobid}, that endpoint is submit-only). The real
 * fix is that google-flow jobids ALSO carry `:` and `@` and must NOT
 * be URL-encoded, same as Dreamina — the raw form is
 *   j0903180709650836584i-u3061-email:isaacisverygoatedtho@gmail.com-bot:google-flow
 * and encoding `%3A` / `%40` trips the router into
 * "Invalid job ID format". Added google-flow to the no-encode list.
 */
export async function checkUseapiJob(input: CheckJobInput): Promise<UseapiJobResult> {
  const pathSegment = input.service === 'dreamina' ? 'videos' : 'jobs';
  // Polish-29.0.21 Commit 130 + Polish-29.0.44 Commit 153: don't
  // encodeURIComponent the jobid for Dreamina OR google-flow. Both
  // useapi routers embed the account email in the id and expect the
  // `:` / `@` chars raw. Percent-encoding trips their router into
  // "Invalid job ID format" (Dreamina) or 400 (google-flow). Keep
  // encoding for every OTHER service out of caution — kling / runway /
  // pixverse / minimax have not been observed carrying account chars,
  // but their format isn't guaranteed stable either.
  const encodedJobId =
    input.service === 'dreamina' || input.service === 'google-flow'
      ? input.jobId
      : encodeURIComponent(input.jobId);
  const url = `${USEAPI_BASE}/${input.service}/${pathSegment}/${encodedJobId}`;
  const result = await callProvider<RawJobBody>({
    userId: input.userId,
    provider: 'useapi_net',
    url,
    method: 'GET',
    headers: authHeaders(),
    timeoutMs: POLL_TIMEOUT_MS,
    requestBodyForLog: { service: input.service, jobid: input.jobId },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    // Polish-29.0.21 Commit 130: same rawBody-dump trick as Commit 122
    // used for submits — append a truncated JSON of the response body
    // so the runs page shows Dreamina's actual rejection reason instead
    // of a bare "HTTP 400".
    let bodyHint = '';
    try {
      const s = JSON.stringify(result.rawBody).slice(0, 400);
      if (s && s !== '{}' && s !== 'null') bodyHint = ` :: body=${s}`;
    } catch {
      /* rawBody unserializable — skip */
    }
    return {
      status: 'failed',
      rawStatus: null,
      errorMessage: (result.errorMessage ?? `HTTP ${result.status}`) + bodyHint,
      raw: {},
    };
  }
  return normalizeJobBody(result.data);
}

// -----------------------------------------------------------------
// Google Flow — Veo video + Nano Banana image
// -----------------------------------------------------------------

export interface SubmitVeoVideoInput {
  userId: string;
  /** Registered Google Flow account email/label to run against. */
  account: string;
  prompt: string;
  /** Registered asset id or a public URL for image-to-video. Optional. */
  referenceImage?: { assetId?: string; url?: string };
  /** Seconds. Default 5. Veo 3 Fast supports 5 or 8. */
  durationSeconds?: 5 | 8;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  /** Which model to hit. */
  model?: 'veo-3-fast' | 'veo-3';
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface SubmitJobResult {
  ok: boolean;
  jobId?: string;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Polish-29.0.35 Commit 145: Omni 1.1 Flash video generation.
 *
 * Google Flow's audio-native talking-head model. Three input modes we
 * care about:
 *   - Text-to-video: prompt only, produces a 4-10s clip
 *   - I2V (first + last frame): startImage = endImage = same still →
 *     the clip begins and ends on that frame with free motion in the
 *     middle. This is what the useapi.net blog uses for the seed clip
 *     of a UGC talking-head chain.
 *   - V2V edit: pass a `referenceVideo` (mediaGenerationId of a prior
 *     Omni output). Omni replays the source's motion + speaker's voice
 *     + camera + framing, but delivers a new line — this is how a
 *     talking-head chain "extends" without a dedicated /extend endpoint
 *     (Omni doesn't support POST /videos/extend; only Veo does).
 *
 * Credits per Google Flow Pro/Ultra tier (per public docs):
 *   - 4s  clip: 7 credits (I2V or T2V) / 20 credits (V2V edit)
 *   - 6s  clip: 10 credits / 20 credits
 *   - 8s  clip: 12 credits / 20 credits
 *   - 10s clip: 15 credits / 20 credits
 *   - 360p variant halves the credit cost
 *
 * All modes use the SAME endpoint (POST /google-flow/videos); which
 * mode Omni picks is determined by which fields are present.
 */
export interface SubmitOmniVideoInput {
  userId: string;
  account: string;
  prompt: string;
  /** Duration seconds. 4 | 6 | 8 | 10. Defaults 4. */
  durationSeconds?: 4 | 6 | 8 | 10;
  /** '9:16' | '1:1' | '16:9'. Defaults 9:16 for UGC. */
  aspectRatio?: '9:16' | '1:1' | '16:9';
  /** '360p' | '720p'. Defaults 720p. */
  resolution?: '360p' | '720p';
  /**
   * I2V mode — a Nano Banana / Nano Banana 2 mediaGenerationId or a
   * public URL used as the FIRST frame. Pass alone for i2v-forward
   * mode, or pair with `endFrame` for the seed-clip pattern where the
   * clip starts AND ends on this frame.
   */
  startFrame?: { assetId?: string; url?: string };
  /**
   * I2V mode — end frame. Pair with startFrame for first+last-frame
   * seeding. If startFrame == endFrame the clip loops seamlessly.
   */
  endFrame?: { assetId?: string; url?: string };
  /**
   * V2V edit mode — mediaGenerationId of a prior Omni video output.
   * The new clip inherits that video's motion, voice, framing, and
   * camera; the prompt supplies the new dialogue. Length matches the
   * source video's length regardless of `durationSeconds`.
   */
  referenceVideo?: { assetId?: string; url?: string };
  generationJobId?: string;
  generatedCreativeId?: string;
}

export async function submitOmniVideo(input: SubmitOmniVideoInput): Promise<SubmitJobResult> {
  const body: Record<string, unknown> = {
    account: input.account,
    prompt: input.prompt,
    model: 'omni-flash',
    duration: input.durationSeconds ?? 4,
    resolution: input.resolution ?? '720p',
  };
  // V2V edit takes length from the source video — durationSeconds is
  // ignored. Aspect ratio also auto-derived from source.
  const referenceVideoRef = input.referenceVideo?.assetId ?? input.referenceVideo?.url;
  const startRef = input.startFrame?.assetId ?? input.startFrame?.url;
  const endRef = input.endFrame?.assetId ?? input.endFrame?.url;
  if (referenceVideoRef) {
    body.referenceVideo_1 = referenceVideoRef;
    // For V2V edit, don't send startFrame/endFrame — Omni auto-derives
    // ratio and length from the source video.
  } else if (startRef || endRef) {
    if (startRef) body.startImage = startRef;
    if (endRef) body.endImage = endRef;
    // I2V mode — omni derives ratio from the frames, don't send ratio.
  } else {
    // T2V mode — send aspect ratio explicitly.
    body.aspectRatio = input.aspectRatio ?? '9:16';
  }

  const result = await callProvider<RawSubmitBody>({
    userId: input.userId,
    provider: 'useapi_net',
    url: `${USEAPI_BASE}/google-flow/videos`,
    method: 'POST',
    headers: authHeaders(),
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      account_hash: hashAccount(input.account),
      model: 'omni-flash',
      duration: body.duration,
      resolution: body.resolution,
      prompt_chars: input.prompt.length,
      mode: referenceVideoRef ? 'v2v_edit' : startRef || endRef ? 'i2v' : 't2v',
      has_start_frame: Boolean(startRef),
      has_end_frame: Boolean(endRef),
      has_reference_video: Boolean(referenceVideoRef),
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  return submitResultOf(result);
}

/**
 * Polish-29.0.35 Commit 145: Google Flow /videos/concatenate.
 *
 * Server-side ffmpeg-style join across a list of prior Google Flow
 * video mediaGenerationIds. Zero credits per useapi.net docs. Optional
 * per-clip trimStart / trimEnd (seconds) let you drop the "quiet
 * beats" that pin each Omni clip to its start/end frame — without
 * trimming a plain join stacks those beats and reads as a freeze.
 *
 * Returns the joined video's mediaGenerationId; poll GET /videos/{jobid}
 * for the finished asset (same as any other Google Flow submit).
 */
export interface GoogleFlowConcatSegment {
  /** mediaGenerationId of a prior Google Flow video output. */
  videoRef: string;
  /** Seconds to trim off the start of this segment. Optional. */
  trimStart?: number;
  /** Seconds to trim off the end of this segment. Optional. */
  trimEnd?: number;
}
export interface SubmitGoogleFlowConcatInput {
  userId: string;
  account: string;
  segments: GoogleFlowConcatSegment[];
  generationJobId?: string;
  generatedCreativeId?: string;
}
export async function submitGoogleFlowConcat(
  input: SubmitGoogleFlowConcatInput,
): Promise<SubmitJobResult> {
  if (input.segments.length < 2) {
    return {
      ok: false,
      latencyMs: 0,
      errorMessage: `Google Flow concat needs at least 2 segments (got ${input.segments.length}).`,
    };
  }
  const body = {
    account: input.account,
    videos: input.segments.map((s) => ({
      video: s.videoRef,
      ...(s.trimStart != null ? { trimStart: s.trimStart } : {}),
      ...(s.trimEnd != null ? { trimEnd: s.trimEnd } : {}),
    })),
  };
  const result = await callProvider<RawSubmitBody>({
    userId: input.userId,
    provider: 'useapi_net',
    url: `${USEAPI_BASE}/google-flow/videos/concatenate`,
    method: 'POST',
    headers: authHeaders(),
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      account_hash: hashAccount(input.account),
      segment_count: input.segments.length,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });
  return submitResultOf(result);
}

export async function submitVeoVideo(input: SubmitVeoVideoInput): Promise<SubmitJobResult> {
  const body = {
    account: input.account,
    prompt: input.prompt,
    model: input.model ?? 'veo-3-fast',
    duration: input.durationSeconds ?? 5,
    aspectRatio: input.aspectRatio ?? '9:16',
    ...(input.referenceImage
      ? { image: input.referenceImage.assetId ?? input.referenceImage.url }
      : {}),
  };

  const result = await callProvider<RawSubmitBody>({
    userId: input.userId,
    provider: 'useapi_net',
    url: `${USEAPI_BASE}/google-flow/videos`,
    method: 'POST',
    headers: authHeaders(),
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      account_hash: hashAccount(input.account),
      model: body.model,
      duration: body.duration,
      aspect_ratio: body.aspectRatio,
      prompt_chars: input.prompt.length,
      has_reference: Boolean(input.referenceImage),
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  return submitResultOf(result);
}

export interface SubmitNanoBananaImageInput {
  userId: string;
  /**
   * Polish-29.0.41 Commit 150: `account` is now IGNORED for the images
   * endpoint. useapi.net's `/google-flow/images` route rejects the
   * field with `{"error":"Parameter account not supported","code":400}`
   * because Nano Banana is a stateless Gemini call under the hood —
   * the API token identifies the billed org, no per-account routing
   * needed. `/google-flow/videos` (Omni, Veo) still requires
   * `account` because those bill against a specific Google AI
   * subscription tier. The field is retained on the input type only
   * for the request-body log hash (audit trail parity with videos),
   * and callers can drop it once they no longer need the audit line.
   */
  account?: string;
  prompt: string;
  /**
   * Polish-29.0.35 Commit 145: Google Flow ships several image models
   * on the same /google-flow/images endpoint. Default nano-banana-2-lite
   * because it's INCLUDED (0 credits) on any Google AI plan and produces
   * the same 720p seed still the useapi.net UGC-clone tutorial uses.
   * Nano Banana 2 / Nano Banana Pro are also 0-credit for image gen
   * per docs — they just have longer render times and higher fidelity.
   */
  model?: 'nano-banana-2-lite' | 'nano-banana-2' | 'nano-banana-pro';
  /** Optional reference image(s) for character-lock composites. */
  referenceImages?: Array<{ assetId?: string; url?: string }>;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  /** How many images to generate in one call. Default 1. */
  n?: number;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export async function submitNanoBananaImage(
  input: SubmitNanoBananaImageInput,
): Promise<SubmitJobResult> {
  // Polish-29.0.41 Commit 150: `account` deliberately omitted from
  // the body — see SubmitNanoBananaImageInput header for the reason.
  //
  // Polish-29.0.42 Commit 151: `n` + `aspectRatio` also stripped.
  // useapi.net's /google-flow/images validator returned
  // `{"error":"Parameter n not supported","code":400}` after the
  // account fix. Nano Banana returns exactly one image per call by
  // design (n=1 is implicit), and the model derives aspect ratio
  // from the prose prompt itself, not a schema field. Our
  // composeSeedStillPrompt already opens with "A single 9:16
  // vertical portrait photo of ..." — that's what Nano Banana
  // reads. The endpoint's supported body is essentially just
  // `{prompt, model}` plus optional `images` for reference-based
  // edits.
  const body = {
    prompt: input.prompt,
    model: input.model ?? 'nano-banana-2-lite',
    ...(input.referenceImages && input.referenceImages.length > 0
      ? { images: input.referenceImages.map((r) => r.assetId ?? r.url) }
      : {}),
  };

  const result = await callProvider<RawSubmitBody>({
    userId: input.userId,
    provider: 'useapi_net',
    url: `${USEAPI_BASE}/google-flow/images`,
    method: 'POST',
    headers: authHeaders(),
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      account_hash: input.account ? hashAccount(input.account) : 'not-sent',
      model: body.model,
      // Ignored aspect_ratio / n retained here as a diagnostic so a
      // future prompt-length regression is easy to spot in the log.
      aspect_ratio_requested: input.aspectRatio ?? '9:16-in-prose',
      n_requested: input.n ?? 1,
      prompt_chars: input.prompt.length,
      reference_count: input.referenceImages?.length ?? 0,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  return submitResultOf(result);
}

// -----------------------------------------------------------------
// Dreamina — Seedance video + Seedream image
// -----------------------------------------------------------------

export interface SubmitSeedanceVideoInput {
  userId: string;
  account: string;
  prompt: string;
  /**
   * Polish-29.0.17 Commit 126: for image-to-video mode, `assetId` must
   * be the `imageRef` string returned by uploadDreaminaImage (which
   * POSTs to /dreamina/assets/account). Raw HTTP URLs no longer work —
   * Dreamina requires their own reference token. The `url` field is
   * kept in the type for backwards compat with the SubmitInput
   * interface shape but is IGNORED here.
   */
  referenceImage?: { assetId?: string; url?: string };
  /** 'seedance-2.5' | 'seedance-2.0'. Default 2.5. */
  /**
   * Seedance model variant. Dreamina exposes several; useapi.net
   * proxies each through the same /dreamina/videos endpoint.
   *   - 'seedance-2.5'        — top-tier quality, slowest
   *   - 'seedance-2.0'        — balanced default
   *   - 'seedance-2.0-fast'   — cheapest, fastest, lower fidelity
   *   - 'seedance-2.0-mini'   — 480p budget option
   *   - 'seedance-1.5-pro'    — legacy pro tier
   */
  model?:
    | 'seedance-2.5'
    | 'seedance-2.0'
    | 'seedance-2.0-fast'
    | 'seedance-2.0-mini'
    | 'seedance-1.5-pro';
  /** Duration in seconds. Seedance 2.5 caps at ~30s per useapi.net. */
  durationSeconds?: number;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  /** Resolution — only meaningful on CA-region accounts. */
  resolution?: '720p' | '1080p' | '4k';
  generationJobId?: string;
  generatedCreativeId?: string;
}

export async function submitSeedanceVideo(
  input: SubmitSeedanceVideoInput,
): Promise<SubmitJobResult> {
  // Polish-29.0.17 Commit 126: aligned with the real Dreamina API docs
  // (finally). Correct field names:
  //   - `ratio`         NOT aspectRatio / aspect_ratio / image
  //   - `firstFrameRef` NOT image / image_url — value is an imageRef
  //     string returned by POST /dreamina/assets/account (raw URLs
  //     won't work; must upload the character PNG to Dreamina first
  //     and pass THEIR reference token here).
  //   - When firstFrameRef is present, `ratio` MUST NOT be sent —
  //     Dreamina auto-detects ratio from the reference image.
  const body: Record<string, unknown> = {
    account: input.account,
    prompt: input.prompt,
    model: input.model ?? 'seedance-2.5',
    duration: input.durationSeconds ?? 5,
  };
  if (input.resolution) body.resolution = input.resolution;
  // firstFrameRef wins over ratio (ratio is auto-derived from image).
  const firstFrameRef = input.referenceImage?.assetId;
  if (firstFrameRef) {
    body.firstFrameRef = firstFrameRef;
  } else if (input.aspectRatio) {
    body.ratio = input.aspectRatio;
  }

  const result = await callProvider<RawSubmitBody>({
    userId: input.userId,
    provider: 'useapi_net',
    url: `${USEAPI_BASE}/dreamina/videos`,
    method: 'POST',
    headers: authHeaders(),
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      account_hash: hashAccount(input.account),
      model: body.model,
      duration: body.duration,
      resolution: body.resolution,
      prompt_chars: input.prompt.length,
      has_reference: Boolean(input.referenceImage),
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  return submitResultOf(result);
}

export interface SubmitSeedreamImageInput {
  userId: string;
  account: string;
  prompt: string;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  n?: number;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export async function submitSeedreamImage(
  input: SubmitSeedreamImageInput,
): Promise<SubmitJobResult> {
  const body = {
    account: input.account,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio ?? '9:16',
    n: input.n ?? 1,
  };

  const result = await callProvider<RawSubmitBody>({
    userId: input.userId,
    provider: 'useapi_net',
    url: `${USEAPI_BASE}/dreamina/images`,
    method: 'POST',
    headers: authHeaders(),
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      account_hash: hashAccount(input.account),
      aspect_ratio: body.aspectRatio,
      n: body.n,
      prompt_chars: input.prompt.length,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  return submitResultOf(result);
}

// -----------------------------------------------------------------
// Shape normalizers
// -----------------------------------------------------------------

type RawSubmitBody = {
  jobid?: string;
  jobId?: string;
  job_id?: string;
  data?: { jobid?: string; jobId?: string };
  error?: unknown;
  message?: string;
};

type RawJobBody = {
  status?: string;
  state?: string;
  jobid?: string;
  video?: { url?: string; downloadUrl?: string };
  videoUrl?: string;
  video_url?: string;
  images?: Array<string | { url?: string; downloadUrl?: string }>;
  imageUrls?: string[];
  result?: {
    url?: string;
    urls?: string[];
    video?: { url?: string };
    images?: Array<string | { url?: string }>;
  };
  // Polish-29.0.22 Commit 131: Dreamina wraps outputs in `response`
  // per docs. Live run completed but returned no_video_url because
  // the parser didn't look inside body.response.*. Cover the shapes
  // that make sense for the docs schema.
  response?: {
    video?: { url?: string; downloadUrl?: string };
    videoUrl?: string;
    video_url?: string;
    videos?: Array<string | { url?: string; downloadUrl?: string }>;
    output?: string | { url?: string };
    result?: { url?: string; video?: { url?: string } };
    url?: string;
    // downloadUrls[] shows up on the completed-video Dreamina response
    downloadUrls?: string[];
  };
  error?: unknown;
  errorMessage?: string;
  message?: string;
};

function submitResultOf<T extends RawSubmitBody>(
  result: Awaited<ReturnType<typeof callProvider<T>>>,
): SubmitJobResult {
  if (!result.ok) {
    // Polish-29.0.13 Commit 122: on failure, append a truncated JSON
    // dump of the raw response body to errorMessage so the concept-form
    // "clip failed" UI surfaces the ACTUAL useapi.net rejection reason
    // (e.g. "unknown account" / "invalid image url") instead of the bare
    // "HTTP 400". Kept short so it survives the 500-char primary_text
    // cap on generated_creatives + the Inngest step return payload cap.
    let bodyHint = '';
    try {
      const s = JSON.stringify(result.rawBody).slice(0, 400);
      if (s && s !== '{}' && s !== 'null') bodyHint = ` :: body=${s}`;
    } catch {
      /* rawBody unserializable — skip */
    }
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: (result.errorMessage ?? `HTTP ${result.status}`) + bodyHint,
    };
  }
  const jobId =
    result.data.jobid ??
    result.data.jobId ??
    result.data.job_id ??
    result.data.data?.jobid ??
    result.data.data?.jobId;
  if (!jobId) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'useapi.net response contained no jobid',
    };
  }
  return { ok: true, jobId, latencyMs: result.latencyMs };
}

function normalizeJobBody(body: RawJobBody): UseapiJobResult {
  const raw = body as unknown as Record<string, unknown>;
  const rawStatus = (body.status ?? body.state ?? '').toLowerCase() || null;
  let status: UseapiJobStatus;
  if (
    rawStatus === 'completed' ||
    rawStatus === 'succeeded' ||
    rawStatus === 'success' ||
    rawStatus === 'done'
  ) {
    status = 'completed';
  } else if (rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'cancelled') {
    status = 'failed';
  } else {
    status = 'processing';
  }

  // Polish-29.0.22 Commit 131: Dreamina wraps its outputs in `response`
  // per docs. Check response.* variants alongside the flat + result.*
  // shapes other useapi.net services use. First non-null wins.
  const responseVideos = body.response?.videos ?? [];
  const firstResponseVideo = (() => {
    const v = responseVideos[0];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.url ?? v.downloadUrl ?? undefined;
    return undefined;
  })();
  const responseOutput = (() => {
    const o = body.response?.output;
    if (typeof o === 'string') return o;
    if (o && typeof o === 'object') return o.url ?? undefined;
    return undefined;
  })();
  const videoUrl =
    body.videoUrl ??
    body.video_url ??
    body.video?.url ??
    body.video?.downloadUrl ??
    body.result?.url ??
    body.result?.video?.url ??
    body.response?.video?.url ??
    body.response?.video?.downloadUrl ??
    body.response?.videoUrl ??
    body.response?.video_url ??
    body.response?.result?.url ??
    body.response?.result?.video?.url ??
    body.response?.url ??
    body.response?.downloadUrls?.[0] ??
    firstResponseVideo ??
    responseOutput;

  const imageUrls: string[] | undefined = (() => {
    const collected: string[] = [];
    if (body.imageUrls) collected.push(...body.imageUrls);
    if (body.images) {
      for (const i of body.images) {
        if (typeof i === 'string') collected.push(i);
        else if (i?.url) collected.push(i.url);
        else if (i?.downloadUrl) collected.push(i.downloadUrl);
      }
    }
    if (body.result?.urls) collected.push(...body.result.urls);
    if (body.result?.images) {
      for (const i of body.result.images) {
        if (typeof i === 'string') collected.push(i);
        else if (i?.url) collected.push(i.url);
      }
    }
    return collected.length > 0 ? collected : undefined;
  })();

  const errorMessage =
    status === 'failed'
      ? (body.errorMessage ??
        body.message ??
        (typeof body.error === 'string' ? body.error : undefined) ??
        'useapi.net job failed')
      : undefined;

  return { status, rawStatus, videoUrl, imageUrls, errorMessage, raw };
}

function extractError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.errorMessage === 'string') return obj.errorMessage;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.error === 'string') return obj.error;
  if (obj.error && typeof obj.error === 'object') {
    const m = (obj.error as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  return null;
}

/**
 * Short deterministic tag for the account identifier so the audit log
 * can correlate calls per-account without persisting the raw email /
 * cookie / label. Not a security primitive — just a diagnostic aid.
 */
function hashAccount(account: string): string {
  let h = 0;
  for (let i = 0; i < account.length; i++) {
    h = (h * 31 + account.charCodeAt(i)) | 0;
  }
  return `acct_${(h >>> 0).toString(36)}`;
}
