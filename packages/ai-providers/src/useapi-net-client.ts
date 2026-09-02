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
const UPLOAD_TIMEOUT_MS = 60_000;

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
  const url =
    input.service === 'dreamina'
      ? `${USEAPI_BASE}/dreamina/assets/account`
      : `${USEAPI_BASE}/${input.service}/assets`;
  const t0 = Date.now();
  try {
    const form = new FormData();
    // Coerce the Uint8Array through a Blob so Node's fetch treats the
    // part as a file part (not a plain field).
    // Use a plain ArrayBuffer copy so we always have BlobPart-compatible input.
    // Uint8Array's underlying buffer might be SharedArrayBuffer in some
    // runtimes, which Blob's TS signature no longer accepts.
    const ab = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(ab).set(input.bytes);
    const blob = new Blob([ab], { type: input.contentType });
    form.append('file', blob, input.filename ?? 'reference.bin');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getUseapiNetToken()}`,
        // NB: do NOT set content-type manually — fetch adds the
        // multipart boundary when it sees a FormData body.
      },
      body: form,
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
  generationJobId?: string;
  generatedCreativeId?: string;
}

/**
 * Poll a single useapi.net job. Callers compose with Inngest
 * `step.sleep` between polls; this function does one status check
 * only. Returns `processing` while upstream keeps grinding.
 */
export async function checkUseapiJob(input: CheckJobInput): Promise<UseapiJobResult> {
  const url = `${USEAPI_BASE}/${input.service}/jobs/${encodeURIComponent(input.jobId)}`;
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
    return {
      status: 'failed',
      rawStatus: null,
      errorMessage: result.errorMessage,
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
  account: string;
  prompt: string;
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
  const body = {
    account: input.account,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio ?? '9:16',
    n: input.n ?? 1,
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
      account_hash: hashAccount(input.account),
      aspect_ratio: body.aspectRatio,
      n: body.n,
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

  const videoUrl =
    body.videoUrl ??
    body.video_url ??
    body.video?.url ??
    body.video?.downloadUrl ??
    body.result?.url ??
    body.result?.video?.url;

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
