import { callProvider } from './chokepoint';

/**
 * Polish-12: kie.ai Gemini Omni Flash video generation client.
 *
 * Omni Flash generates 10s video with NATIVE synchronized audio +
 * lipsync from one prompt + optional reference image. Collapses the
 * Polish-11 multi-clip + ElevenLabs TTS + lipsync Frankenstein into
 * one API call.
 *
 * Endpoints (verified against kie.ai docs Nov 2026):
 *   - POST /api/v1/jobs/createTask           — submit (model 'gemini-omni-video')
 *   - GET  /api/v1/jobs/recordInfo?taskId=…  — poll status + resultJson
 *
 * Auth: `Authorization: Bearer <apiKey>`.
 *
 * Pricing: $0.90 per 10s 1080p generation (Nov 2026 list).
 *
 * IMPORTANT: the poll response's `data.resultJson` is a JSON STRING.
 * Must JSON.parse() to access `resultUrls[0]`. Easy to miss.
 *
 * NOTE: distinct from kie-ai-client.ts (deprecated Sora 2 endpoint).
 * Both use the same Bearer-token auth + 'kie_ai' chokepoint provider
 * but hit different paths.
 */

const KIE_BASE = 'https://api.kie.ai/api/v1';
export const KIE_OMNI_VIDEO_MODEL = 'gemini-omni-video';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;

/** $0.90 per 10s 1080p generation. Tuneable via env. */
const KIE_OMNI_COST_USD_PER_GENERATION =
  Number(process.env.KIE_OMNI_COST_USD_PER_GENERATION) || 0.9;

export function estimateKieOmniGenerationCostUsd(): number {
  return KIE_OMNI_COST_USD_PER_GENERATION;
}

export type KieOmniDuration = '4' | '6' | '8' | '10';
export type KieOmniAspectRatio = '16:9' | '9:16';
export type KieOmniResolution = '720p' | '1080p' | '4k';
export type KieOmniState = 'waiting' | 'success' | 'fail';

export interface KieOmniSubmitInput {
  userId: string;
  apiKey: string;
  /** Max 20,000 chars per Omni Flash schema. */
  prompt: string;
  /** Public URLs, max 10MB each, jpeg/png/webp/jpg. */
  imageUrls?: string[];
  /** Default '10' (max for Omni). */
  durationSeconds?: KieOmniDuration;
  /** Default '9:16' for UGC ads. */
  aspectRatio?: KieOmniAspectRatio;
  /** Default '1080p'. */
  resolution?: KieOmniResolution;
  seed?: number;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieOmniSubmitResult {
  ok: boolean;
  taskId?: string;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Submit an Omni Flash generation request. Returns `taskId` for
 * polling. kie.ai's failure codes are translated into actionable
 * messages so the worker's job-failed marker tells the operator
 * exactly what's wrong (auth vs balance vs validation vs rate
 * limit vs upstream).
 */
export async function submitKieOmniVideo(input: KieOmniSubmitInput): Promise<KieOmniSubmitResult> {
  const url = `${KIE_BASE}/jobs/createTask`;
  const body: { model: string; input: Record<string, unknown> } = {
    model: KIE_OMNI_VIDEO_MODEL,
    input: {
      prompt: input.prompt,
      duration: input.durationSeconds ?? '10',
      aspect_ratio: input.aspectRatio ?? '9:16',
      resolution: input.resolution ?? '1080p',
    },
  };
  if (input.imageUrls && input.imageUrls.length > 0) {
    body.input.image_urls = input.imageUrls;
  }
  if (input.seed !== undefined) {
    body.input.seed = input.seed;
  }

  const result = await callProvider<{
    code?: number;
    msg?: string;
    data?: { taskId?: string; task_id?: string };
  }>({
    userId: input.userId,
    provider: 'kie_ai',
    url,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      model: KIE_OMNI_VIDEO_MODEL,
      prompt_chars: input.prompt.length,
      duration: body.input.duration,
      aspect_ratio: body.input.aspect_ratio,
      resolution: body.input.resolution,
      reference_image_count: input.imageUrls?.length ?? 0,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieErrorStatus(result.status, result.errorMessage),
    };
  }

  // kie.ai wraps every response in { code, msg, data }. Non-200 code
  // is a soft failure (validation error etc.) and the HTTP layer
  // returned 200.
  if (result.data.code !== undefined && result.data.code !== 200) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieErrorStatus(result.data.code, result.data.msg),
    };
  }

  const taskId = result.data.data?.taskId ?? result.data.data?.task_id;
  if (!taskId) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'kie.ai createTask response missing taskId',
    };
  }
  return { ok: true, taskId, latencyMs: result.latencyMs };
}

export interface KieOmniPollInput {
  userId: string;
  apiKey: string;
  taskId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieOmniPollResult {
  ok: boolean;
  state?: KieOmniState;
  /** First entry from resultJson.resultUrls; populated only on success. */
  outputUrl?: string;
  failCode?: string;
  failMsg?: string;
  costTimeMs?: number;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Single status check. Caller composes with `step.sleep` for the
 * polling loop. Parses the JSON-stringified `resultJson` field on
 * success to extract the output URL.
 */
export async function pollKieOmniTask(input: KieOmniPollInput): Promise<KieOmniPollResult> {
  const url = `${KIE_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(input.taskId)}`;

  const result = await callProvider<{
    code?: number;
    msg?: string;
    data?: {
      taskId?: string;
      state?: KieOmniState;
      resultJson?: string | null;
      failCode?: string | null;
      failMsg?: string | null;
      costTime?: number;
      completeTime?: number;
      createTime?: number;
    };
  }>({
    userId: input.userId,
    provider: 'kie_ai',
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${input.apiKey}` },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { taskId: input.taskId },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieErrorStatus(result.status, result.errorMessage),
    };
  }
  if (result.data.code !== undefined && result.data.code !== 200) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieErrorStatus(result.data.code, result.data.msg),
    };
  }

  const data = result.data.data;
  if (!data) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'kie.ai recordInfo response missing data',
    };
  }

  const state = data.state;
  if (state === 'success') {
    const outputUrl = parseResultJsonOutputUrl(data.resultJson);
    return {
      ok: true,
      state: 'success',
      outputUrl,
      costTimeMs: data.costTime,
      latencyMs: result.latencyMs,
    };
  }
  if (state === 'fail') {
    // Polish-12.2.2: kie.ai's actual response often returns the
    // failure code in failMsg with failCode left null, despite docs
    // showing them as separate fields. Treat failMsg as the code
    // when it matches the documented identifier pattern
    // (PUBLIC_ERROR_ uppercase identifier) and failCode is empty.
    const rawCode = data.failCode ?? undefined;
    const rawMsg = data.failMsg ?? undefined;
    const inferredCode =
      !rawCode && rawMsg && /^[A-Z][A-Z0-9_]+$/.test(rawMsg.trim()) ? rawMsg.trim() : rawCode;
    return {
      ok: true,
      state: 'fail',
      failCode: inferredCode,
      failMsg: rawMsg ?? 'kie.ai task failed without a message',
      latencyMs: result.latencyMs,
    };
  }
  // 'waiting' or any other in-flight state.
  return {
    ok: true,
    state: state ?? 'waiting',
    latencyMs: result.latencyMs,
  };
}

/**
 * Extract the first entry of `resultUrls` from the JSON-stringified
 * `resultJson` field. Returns undefined when parsing fails or the
 * expected shape is missing — caller's worker treats that as a soft
 * failure and surfaces a clear error to the operator.
 */
export function parseResultJsonOutputUrl(raw: string | null | undefined): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const urls = (parsed as { resultUrls?: unknown }).resultUrls;
  if (!Array.isArray(urls) || urls.length === 0) return undefined;
  const first = urls[0];
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

/**
 * Map kie.ai's documented error codes to actionable strings.
 *   401 → bad API key
 *   402 → insufficient account balance
 *   422 → schema / validation failure
 *   429 → rate limited
 *   404 → resource not found (e.g. unknown taskId)
 *   5xx → upstream error
 */
export function translateKieErrorStatus(
  status: number | undefined,
  fallback: string | undefined,
): string {
  if (status === 401)
    return 'kie.ai authentication failed (invalid API key). Re-paste your key at /connections/tools.';
  if (status === 402) return 'kie.ai account has insufficient balance. Top up at kie.ai → Billing.';
  if (status === 404) return `kie.ai resource not found${fallback ? `: ${fallback}` : ''}.`;
  if (status === 422)
    return `kie.ai validation failed${fallback ? `: ${fallback}` : ' (check the prompt + reference image)'}.`;
  if (status === 429) return 'kie.ai rate limit hit. Retry in a few seconds.';
  if (typeof status === 'number' && status >= 500)
    return `kie.ai upstream error (HTTP ${status}${fallback ? `: ${fallback}` : ''}).`;
  return fallback ?? `kie.ai request failed${status ? ` (status ${status})` : ''}.`;
}
