/**
 * Polish-23 Commit 2: kie.ai Veo 3.1 Lite client (dedicated
 * `/veo/generate` product surface).
 *
 * Not a resurrection of the Polish-19.4.x veo.ts file (that one
 * hit Google's Gemini Developer API via
 * generativelanguage.googleapis.com/…/predictLongRunning). This
 * client targets kie.ai's dedicated Veo product endpoint, which
 * wraps Google's Veo behind kie.ai's credit-metered API surface.
 *
 * Endpoints (per kie.ai Veo product docs):
 *   - Submit: POST https://api.kie.ai/api/v1/veo/generate
 *   - Poll:   GET  https://api.kie.ai/api/v1/veo/record-info?taskId=<id>
 *
 * Auth: `Authorization: Bearer <apiKey>` (same header as kie-video.ts).
 *
 * Response wrapping (Polish-20 Commit 2 pattern): kie.ai wraps every
 * response body in `{code, msg, data}`. HTTP-level 200 with `code !=
 * 200` is a soft failure that translates through
 * translateKieVeoErrorStatus.
 *
 * Model string: `veo3_lite` (BCH-verified for Veo 3.1 Lite 1080p
 * mode). Env override VEO_LITE_MODEL_ID_OVERRIDE flips it without
 * a redeploy if kie.ai renames.
 *
 * Cost: 35 credits ≈ $0.175 per 8s clip (BCH-verified 2026-07-15).
 * Env-tunable via KIE_VEO_LITE_USD_PER_CLIP_OVERRIDE.
 *
 * Ratelimit + poll patterns adapted from the Polish-19.4.3 Google-
 * Gemini veo.ts (exponential backoff [10, 20, 40, 60, 60]s over 5
 * retries) — kept independent so Kling/Seedance retry tunings on
 * kie-video.ts don't couple to this module.
 *
 * First-live drift diagnostic: FULL request body loud-logged on
 * the first submit + poll per (kind, model) tuple so response-shape
 * drift surfaces in Inngest without a redeploy.
 */
import { callProvider } from './chokepoint';

const KIE_BASE = 'https://api.kie.ai/api/v1';
const KIE_VEO_SUBMIT_URL = `${KIE_BASE}/veo/generate`;
const kieVeoPollUrl = (taskId: string) =>
  `${KIE_BASE}/veo/record-info?taskId=${encodeURIComponent(taskId)}`;

const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;

/**
 * Polish-23 Commit 3.0.7: kie.ai's documented model values on the
 * /veo/generate endpoint are `veo3` (Quality tier) and `veo3_fast`
 * (Fast tier). The `veo3_lite` string from the operator's Commit 2
 * spec did NOT match kie.ai's API — BCH's verified $0.175/clip
 * pricing corresponds to the FAST tier, which kie.ai calls
 * `veo3_fast`. Docs:
 *   https://docs.kie.ai/veo3-api/generate-veo-3-video
 *   https://docs.kie.ai/veo3-api/quickstart
 * Env override VEO_LITE_MODEL_ID_OVERRIDE kept for post-launch
 * flexibility (e.g. flipping to `veo3` for premium runs).
 */
export const VEO_LITE_DEFAULT_MODEL_ID = 'veo3_fast';

export function getVeoLiteModelId(): string {
  return process.env['VEO_LITE_MODEL_ID_OVERRIDE']?.trim() || VEO_LITE_DEFAULT_MODEL_ID;
}

export const KIE_VEO_LITE_DEFAULT_USD_PER_CLIP = 0.175;
export const KIE_VEO_LITE_DEFAULT_CLIP_SECONDS = 8;
export const KIE_VEO_LITE_DEFAULT_CREDITS_PER_CLIP = 35;

export function getKieVeoLiteUsdPerClip(): number {
  const raw = process.env['KIE_VEO_LITE_USD_PER_CLIP_OVERRIDE']?.trim();
  if (!raw) return KIE_VEO_LITE_DEFAULT_USD_PER_CLIP;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : KIE_VEO_LITE_DEFAULT_USD_PER_CLIP;
}

export function estimateKieVeoLiteClipCostUsd(clipCount = 1): number {
  return Math.max(0, Math.floor(clipCount)) * getKieVeoLiteUsdPerClip();
}

// -------------------------------------------------------------------
// Rate-limit primitives (Polish-19.4.3 pattern, per-module namespace)
// -------------------------------------------------------------------

export const KIE_VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES = 5;

export function computeKieVeoRateLimitBackoffMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return 10_000;
  const raw = 10_000 * Math.pow(2, attempt);
  return Math.min(60_000, raw);
}

export function getKieVeoRateLimitMaxRetries(): number {
  const raw = process.env['KIE_VEO_RATE_LIMIT_MAX_RETRIES']?.trim();
  if (!raw) return KIE_VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    console.log(
      `[kie-veo] ignoring KIE_VEO_RATE_LIMIT_MAX_RETRIES=${JSON.stringify(raw)} — ` +
        `not a non-negative integer; falling back to default (${KIE_VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES}).`,
    );
    return KIE_VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES;
  }
  return n;
}

/**
 * kie.ai rate-limit surfaces on the Veo product endpoint:
 *   - HTTP 429 on the transport
 *   - `{code: 429}` in the wrapped body
 *   - message substrings "rate limit" / "quota exceeded" / "too many requests"
 */
export function detectKieVeoRateLimit(
  status: number | undefined,
  kieCode: number | undefined,
  errorMessage: string | undefined,
): boolean {
  if (status === 429) return true;
  if (kieCode === 429) return true;
  if (typeof errorMessage === 'string') {
    const lower = errorMessage.toLowerCase();
    if (lower.includes('rate limit')) return true;
    if (lower.includes('quota exceeded')) return true;
    if (lower.includes('too many requests')) return true;
  }
  return false;
}

let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function __setKieVeoSleepImplForTests(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}

export function __restoreKieVeoSleepImplForTests(): void {
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------------
// Submit
// -------------------------------------------------------------------

export interface KieVeoSubmitInput {
  userId: string;
  apiKey: string;
  /** Fully-composed per-clip prompt (see composeVeoLiteSegmentPrompt). */
  prompt: string;
  /** Aspect ratio wire value; defaults to '9:16'. */
  aspectRatio?: '9:16' | '16:9' | '1:1';
  /**
   * Reference image URLs (Higgsfield Soul PNG, one per batch). Threaded
   * into imageUrls[] on the submit so every clip anchors to the same
   * character. Optional so the client stays usable outside the Polish-23
   * flow (e.g. a text-only Veo clip for debugging).
   */
  imageUrls?: string[];
  /** Per-clip duration seconds; kie.ai Veo Lite = 8s (fixed). */
  durationSeconds?: number;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieVeoSubmitResult {
  ok: boolean;
  taskId?: string;
  latencyMs: number;
  errorMessage?: string;
  /**
   * Polish-23 Commit 3.0.6: transient vs terminal classification.
   * Callers wrap terminal errors in Inngest's NonRetriableError
   * so retries burn no additional kie.ai credits on validation /
   * auth / balance / model-not-found failures. Undefined on the
   * happy path (ok:true) and on retry-limbo shapes where the
   * classification is genuinely unknown.
   *   - 'terminal':  400 / 401 / 402 / 404 / 422 / body-code
   *                  equivalents / any parse-shape drift
   *   - 'transient': 429 / 5xx / transport / body-code 429
   */
  errorKind?: 'terminal' | 'transient';
  /**
   * Polish-23 Commit 3.0.8: full unwrapped response body kie.ai
   * sent back on the failure path. Callers persist this to
   * job.metadata.polish23_veo_error_response for durable diagnostic
   * inspection. Undefined on the happy path.
   */
  rawErrorBody?: unknown;
}

interface KieVeoSubmitResponse {
  code?: number;
  msg?: string;
  data?: { taskId?: string; task_id?: string };
}

/**
 * Polish-23 Commit 3.0.7: FLAT request body — kie.ai's Veo endpoint
 * takes fields at the top level, NOT under an `input` wrapper.
 * Commit 2 extrapolated `{model, input: {...}}` from the generic
 * `/jobs/createTask` pattern (which IS correct for Kling/Seedance),
 * but the dedicated `/veo/generate` product surface uses a flat
 * body per the documented curl example:
 *
 *   {
 *     "prompt": "…",
 *     "imageUrls": ["…"],           // optional; when present →
 *                                   // generationType=REFERENCE_2_VIDEO
 *     "model": "veo3_fast",
 *     "aspect_ratio": "9:16",       // snake_case per docs
 *     "enableFallback": false,
 *     "enableTranslation": true,
 *     "generationType": "REFERENCE_2_VIDEO" | "TEXT_2_VIDEO"
 *   }
 *
 * NO `duration` field — Veo 3.1 clips are fixed 8s server-side.
 * NO `aspectRatio` camelCase.
 *
 * Docs: https://docs.kie.ai/veo3-api/generate-veo-3-video
 *
 * The return type is intentionally the wire shape (Record<string,
 * unknown>) so worker-side forensics persist EXACTLY what kie.ai
 * receives, and JSON.stringify(body) sends the same bytes.
 */
export function buildKieVeoRequestBody(input: KieVeoSubmitInput): Record<string, unknown> {
  const modelParam = getVeoLiteModelId();
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    model: modelParam,
    aspect_ratio: input.aspectRatio ?? '9:16',
    enableFallback: false,
    enableTranslation: true,
  };
  if (input.imageUrls && input.imageUrls.length > 0) {
    body['imageUrls'] = input.imageUrls;
    body['generationType'] = 'REFERENCE_2_VIDEO';
  } else {
    body['generationType'] = 'TEXT_2_VIDEO';
  }
  return body;
}

export async function submitKieVeoLite(input: KieVeoSubmitInput): Promise<KieVeoSubmitResult> {
  return retryKieVeoSubmit(() => submitKieVeoLiteOnce(input));
}

async function submitKieVeoLiteOnce(input: KieVeoSubmitInput): Promise<KieVeoSubmitResult> {
  const modelParam = getVeoLiteModelId();
  const body = buildKieVeoRequestBody(input);
  // Polish-23 Commit 3.0.7: logFirstIfFirstCall's second param is
  // the { model, input: {…} } shape; keep the log shape stable by
  // wrapping the flat body under a synthetic 'input' key for the
  // diagnostic bundle only. The wire body is still flat.
  logFirstIfFirstCall('submit', modelParam, { model: modelParam, input: body });

  const result = await callProvider<KieVeoSubmitResponse>({
    userId: input.userId,
    provider: 'kie_ai',
    url: KIE_VEO_SUBMIT_URL,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      model: modelParam,
      prompt_chars: input.prompt.length,
      // Polish-23 Commit 3.0.7: aspect_ratio is now a top-level flat
      // field on the wire body; log matches.
      aspect_ratio: body['aspect_ratio'],
      generation_type: body['generationType'],
      image_count: input.imageUrls?.length ?? 0,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    // Polish-23 Commit 3.0.3: on ANY submit failure (transport OR
    // soft), loud-log the FULL request body we sent + the full
    // response body we got back. If kie.ai's /veo/generate endpoint
    // expects a different body shape than {model, input: {...}}
    // (e.g. flat fields at the top level, matching some product-
    // specific SDKs), this pair of logs makes the mismatch visible
    // in Inngest without a redeploy.
    console.error(
      `[kie-veo] submit transport failure: model=${modelParam} status=${result.status} ` +
        `err=${result.errorMessage ?? 'unknown'} ` +
        `\n[kie-veo] request body sent: ${JSON.stringify(body).slice(0, 2000)}` +
        `\n[kie-veo] response body: ${JSON.stringify(result.rawBody).slice(0, 2000)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieVeoErrorStatus(result.status, result.errorMessage),
      errorKind: classifyKieVeoErrorKind(result.status, undefined, result.errorMessage),
      rawErrorBody: result.rawBody,
    };
  }
  const code = result.data.code;
  if (code !== undefined && code !== 200) {
    console.error(
      `[kie-veo] submit soft failure: model=${modelParam} code=${code} ` +
        `msg=${result.data.msg ?? 'unknown'} ` +
        `\n[kie-veo] request body sent: ${JSON.stringify(body).slice(0, 2000)}` +
        `\n[kie-veo] response body: ${JSON.stringify(result.data).slice(0, 2000)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieVeoErrorStatus(code, result.data.msg),
      errorKind: classifyKieVeoErrorKind(undefined, code, result.data.msg),
      rawErrorBody: result.data,
    };
  }
  const taskId = result.data.data?.taskId ?? result.data.data?.task_id;
  if (!taskId) {
    console.log(
      `[kie-veo] submit succeeded but missing taskId; body=${JSON.stringify(result.data).slice(0, 1500)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'kie.ai Veo submit response missing taskId',
      errorKind: 'terminal',
      rawErrorBody: result.data,
    };
  }
  return { ok: true, taskId, latencyMs: result.latencyMs };
}

// -------------------------------------------------------------------
// Poll
// -------------------------------------------------------------------

export type KieVeoState = 'waiting' | 'success' | 'fail';

export interface KieVeoPollInput {
  userId: string;
  apiKey: string;
  taskId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieVeoPollResult {
  ok: boolean;
  state?: KieVeoState;
  outputUrl?: string;
  failCode?: string;
  failMsg?: string;
  costTimeMs?: number;
  latencyMs: number;
  errorMessage?: string;
  /** Polish-23 Commit 3.0.6: same terminal/transient contract as KieVeoSubmitResult. */
  errorKind?: 'terminal' | 'transient';
  /** Polish-23 Commit 3.0.8: full raw poll response on failure paths. */
  rawErrorBody?: unknown;
  /**
   * Polish-23 Commit 3.0.9: raw kie.ai response body on EVERY poll
   * path (success + failure). Set from callProvider's result.data
   * on both branches so the worker can persist verbatim to
   * metadata.polish23_veo_poll_responses BEFORE any state-parsing
   * or throw. This is the observability field that unblocks
   * decoding kie.ai's actual poll shape (see Commit 3.0.9 spec).
   */
  rawResponseBody?: unknown;
}

interface KieVeoPollResponse {
  code?: number;
  msg?: string;
  data?: {
    taskId?: string;
    state?: KieVeoState;
    /** kie.ai Veo product surface returns URLs either as an array... */
    resultUrls?: string[] | null;
    /** ...or nested inside a JSON-encoded string (kie-video.ts pattern). */
    resultJson?: string | null;
    failCode?: string | null;
    failMsg?: string | null;
    costTime?: number | null;
  };
}

export async function pollKieVeoLite(input: KieVeoPollInput): Promise<KieVeoPollResult> {
  const result = await callProvider<KieVeoPollResponse>({
    userId: input.userId,
    provider: 'kie_ai',
    url: kieVeoPollUrl(input.taskId),
    method: 'GET',
    headers: { Authorization: `Bearer ${input.apiKey}` },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { taskId: input.taskId },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });
  logFirstIfFirstCall('poll', 'veo3_lite', { model: 'veo3_lite', input: { taskId: input.taskId } });

  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieVeoErrorStatus(result.status, result.errorMessage),
      errorKind: classifyKieVeoErrorKind(result.status, undefined, result.errorMessage),
      rawErrorBody: result.rawBody,
      rawResponseBody: result.rawBody,
    };
  }
  const code = result.data.code;
  if (code !== undefined && code !== 200) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieVeoErrorStatus(code, result.data.msg),
      errorKind: classifyKieVeoErrorKind(undefined, code, result.data.msg),
      rawErrorBody: result.data,
      rawResponseBody: result.data,
    };
  }
  const data = result.data.data;
  const state = data?.state;
  if (!state) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'kie.ai Veo record-info missing state field',
      errorKind: 'terminal',
      rawErrorBody: result.data,
      rawResponseBody: result.data,
    };
  }
  if (state === 'fail') {
    // Polish-23 Commit 3.0.6: state='fail' is ALWAYS terminal —
    // kie.ai has issued a definitive judgment on the task. A retry
    // of the same taskId would poll the same failed state; a retry
    // of the whole clip would burn credits on the same rejected
    // input. Callers wrap this in NonRetriableError.
    return {
      ok: true,
      state,
      failCode: data.failCode ?? undefined,
      failMsg: data.failMsg ?? undefined,
      latencyMs: result.latencyMs,
      errorKind: 'terminal',
      rawErrorBody: result.data,
      rawResponseBody: result.data,
    };
  }
  if (state === 'success') {
    const outputUrl = extractVeoOutputUrl(data.resultUrls, data.resultJson);
    if (!outputUrl) {
      console.log(
        `[kie-veo] poll done but no outputUrl; taskId=${input.taskId} ` +
          `body=${JSON.stringify(result.data).slice(0, 2000)}`,
      );
      return {
        ok: true,
        state,
        latencyMs: result.latencyMs,
        errorMessage: 'kie.ai Veo reported success but no output URL in response',
        rawResponseBody: result.data,
      };
    }
    return {
      ok: true,
      state,
      outputUrl,
      costTimeMs: data.costTime ?? undefined,
      latencyMs: result.latencyMs,
      rawResponseBody: result.data,
    };
  }
  return { ok: true, state, latencyMs: result.latencyMs, rawResponseBody: result.data };
}

/**
 * kie.ai's Veo product response has drifted between two forms — a
 * top-level `resultUrls: string[]` array and a JSON-encoded
 * `resultJson: '{"resultUrls":["…"]}'` string (matching the
 * legacy kie-video.ts shape). Handle both defensively so a first-
 * live shape drift doesn't require a redeploy.
 */
export function extractVeoOutputUrl(
  resultUrls: string[] | null | undefined,
  resultJson: string | null | undefined,
): string | undefined {
  if (Array.isArray(resultUrls) && typeof resultUrls[0] === 'string' && resultUrls[0].length > 0) {
    return resultUrls[0];
  }
  if (typeof resultJson === 'string' && resultJson.length > 0) {
    try {
      const parsed = JSON.parse(resultJson) as { resultUrls?: unknown };
      const urls = parsed.resultUrls;
      if (Array.isArray(urls) && typeof urls[0] === 'string' && urls[0].length > 0) {
        return urls[0];
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// -------------------------------------------------------------------
// Error translation
// -------------------------------------------------------------------

/**
 * Polish-23 Commit 3.0.6: classify a kie.ai submit/poll failure as
 * transient (retry-worth) or terminal (validation / auth / balance /
 * shape drift; retries burn credits for no gain). Callers wrap
 * terminal errors in Inngest's NonRetriableError.
 *
 * HTTP status precedence: if the transport returned a status code,
 * that wins. Falls back to kie.ai body-code / errorMessage substring
 * matches.
 */
export function classifyKieVeoErrorKind(
  status: number | undefined,
  kieCode: number | undefined,
  errorMessage: string | undefined,
): 'terminal' | 'transient' {
  if (status === 429) return 'transient';
  if (typeof status === 'number' && status >= 500) return 'transient';
  if (status === 400 || status === 401 || status === 402 || status === 404 || status === 422) {
    return 'terminal';
  }
  if (kieCode === 429) return 'transient';
  if (kieCode === 400 || kieCode === 401 || kieCode === 402 || kieCode === 404 || kieCode === 422) {
    return 'terminal';
  }
  if (typeof errorMessage === 'string') {
    const lower = errorMessage.toLowerCase();
    if (lower.includes('rate limit') || lower.includes('too many requests')) return 'transient';
    if (lower.includes('upstream error')) return 'transient';
    if (lower.includes('please enter prompt') || lower.includes('validation')) return 'terminal';
    if (lower.includes('insufficient') && lower.includes('balance')) return 'terminal';
    if (lower.includes('authentication failed')) return 'terminal';
    if (lower.includes('not found')) return 'terminal';
    if (lower.includes('missing taskid')) return 'terminal';
    if (lower.includes('missing state')) return 'terminal';
  }
  // Default: treat unknown as terminal — safer to fail fast than to
  // retry a mystery error and burn credits blindly. Operator can
  // rerun manually if it turns out to have been transient.
  return 'terminal';
}

export function translateKieVeoErrorStatus(
  status: number | undefined,
  fallback: string | undefined,
): string {
  if (status === 400)
    return `kie.ai Veo validation failed${fallback ? `: ${fallback}` : ' (check prompt + reference image)'}.`;
  if (status === 401)
    return 'kie.ai authentication failed. Re-paste your key at /connections/tools.';
  if (status === 402)
    return 'Insufficient kie.ai balance for Veo 3.1 Lite (35 credits/clip). Top up at kie.ai/api-key.';
  if (status === 404)
    return `kie.ai Veo resource not found${fallback ? `: ${fallback}` : ''}. Check taskId or model string.`;
  if (status === 422)
    return `kie.ai Veo parameter validation failed${fallback ? `: ${fallback}` : ''}.`;
  if (status === 429) return 'kie.ai Veo rate limit hit. Retry in a few seconds.';
  if (typeof status === 'number' && status >= 500)
    return `kie.ai Veo upstream error (HTTP ${status}${fallback ? `: ${fallback}` : ''}).`;
  return fallback ?? `kie.ai Veo request failed${status ? ` (status ${status})` : ''}.`;
}

// -------------------------------------------------------------------
// Retry wrapper + first-call diagnostic
// -------------------------------------------------------------------

async function retryKieVeoSubmit(
  makeCall: () => Promise<KieVeoSubmitResult>,
): Promise<KieVeoSubmitResult> {
  const maxRetries = getKieVeoRateLimitMaxRetries();
  let last: KieVeoSubmitResult | undefined;
  let totalWaitMs = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await makeCall();
    if (r.ok) return r;
    const rateLimited = detectKieVeoRateLimit(undefined, undefined, r.errorMessage);
    if (!rateLimited) return r;
    last = r;
    if (attempt === maxRetries) break;
    const backoffMs = computeKieVeoRateLimitBackoffMs(attempt);
    totalWaitMs += backoffMs;
    console.log(
      `[kie-veo-submit] rate-limit hit on attempt ${attempt + 1}/${maxRetries + 1}, ` +
        `backing off ${Math.round(backoffMs / 1000)}s before retry ` +
        `(err: ${r.errorMessage ?? 'unknown'})`,
    );
    await sleepImpl(backoffMs);
  }
  const totalWaitSec = Math.round(totalWaitMs / 1000);
  const lastMsg = last?.errorMessage ?? 'unknown';
  return {
    ok: false,
    latencyMs: last?.latencyMs ?? 0,
    errorMessage:
      `kie.ai Veo rate limit hit after ${maxRetries + 1} attempts over ~${totalWaitSec}s. ` +
      `Last error: ${lastMsg}. Consider raising KIE_VEO_RATE_LIMIT_MAX_RETRIES ` +
      `or reducing concurrent clips.`,
    // Polish-23 Commit 3.0.6: retry-loop exhaustion IS transient by
    // definition — every underlying attempt hit a rate-limit that
    // detectKieVeoRateLimit classified as retry-worth. Callers can
    // treat the whole result as transient (worker will still fail
    // fast if the caller's own retry policy is exhausted).
    errorKind: 'transient',
  };
}

const _firstCallLogged = new Set<string>();
function logFirstIfFirstCall(
  kind: 'submit' | 'poll',
  modelId: string,
  body: { model: string; input: Record<string, unknown> },
): void {
  const key = `${kind}:${modelId}`;
  if (_firstCallLogged.has(key)) return;
  _firstCallLogged.add(key);
  console.log(
    `[kie-veo] first-${kind} for model=${modelId}: full body=${JSON.stringify(body).slice(0, 2000)}`,
  );
}

export function __resetKieVeoFirstCallLogForTests(): void {
  _firstCallLogged.clear();
}
