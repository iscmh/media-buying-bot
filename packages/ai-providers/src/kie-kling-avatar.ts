import { callProvider } from './chokepoint';

/**
 * Polish-19: kie.ai Kling Avatar v2 (Pro) video generation client.
 *
 * Kling Avatar v2 animates a provided portrait image with a provided
 * audio track, producing a lipsynced talking-head MP4 in one call —
 * up to 5 minutes per generation. Compared to the Polish-12 Omni Flash
 * pipeline this skips the multi-segment splitter, the chain-frame
 * extraction, the kie.ai character pre-registration, and the heavy
 * anti-celebrity scrub (the model isn't generating a face from scratch,
 * just animating one we supply).
 *
 * Endpoints (verified against kie.ai docs Dec 2026):
 *   - POST /api/v1/jobs/createTask              — submit (model 'kling/ai-avatar-pro')
 *   - GET  /api/v1/jobs/recordInfo?taskId=…     — poll status + resultJson
 *
 * Auth: `Authorization: Bearer <apiKey>` (same as kie-omni).
 *
 * Pricing (Dec 2026 list): $0.115 per second of OUTPUT video. A 30s
 * variant is ~$3.45 of Kling cost.
 *
 * IMPORTANT: same as kie-omni, the poll response's `data.resultJson`
 * is a JSON STRING. JSON.parse() is required to reach `resultUrls[0]`.
 * We reuse parseResultJsonOutputUrl from kie-omni.ts.
 *
 * NOTE: kie.ai's public catalog as of Dec 2026 lists only the Pro tier
 * for ai-avatar v2. If kie.ai later exposes a Standard tier (~50%
 * cheaper), override KIE_KLING_AVATAR_MODEL_ID without a code change.
 */

const KIE_BASE = 'https://api.kie.ai/api/v1';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;

export const KIE_KLING_AVATAR_DEFAULT_MODEL = 'kling/ai-avatar-pro';

/**
 * Polish-19: env override so a kie.ai model-string rename (or a future
 * Standard tier flag-flip) is a config change, not a redeploy. The
 * worker surfaces kie.ai's exact error message on model-not-found, so
 * a wrong value is loud and immediately correctable.
 */
export function getKieKlingAvatarModelId(): string {
  return process.env.KIE_KLING_AVATAR_MODEL_ID?.trim() || KIE_KLING_AVATAR_DEFAULT_MODEL;
}

/** $0.115 per second of generated video. Tuneable via env. */
const KIE_KLING_AVATAR_USD_PER_SECOND =
  Number(process.env.KIE_KLING_AVATAR_USD_PER_SECOND) || 0.115;

export function estimateKieKlingAvatarCostUsd(durationSeconds: number): number {
  return Math.max(0, durationSeconds) * KIE_KLING_AVATAR_USD_PER_SECOND;
}

export type KieKlingAvatarState = 'waiting' | 'success' | 'fail';

export interface KieKlingAvatarSubmitInput {
  userId: string;
  apiKey: string;
  /** Public URL, max 10MB, jpeg or png. */
  imageUrl: string;
  /** Public URL, max 100MB, ≤5min, mpeg/wav/aac/mp4/ogg. */
  audioUrl: string;
  /**
   * Optional animation-style guidance. Max 5000 chars. The kie.ai docs
   * mark `prompt` as required (empty string default) — we always send
   * the field, defaulting to an empty string when the caller omits it.
   */
  prompt?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieKlingAvatarSubmitResult {
  ok: boolean;
  taskId?: string;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Submit a Kling Avatar v2 generation. Returns `taskId` for polling.
 * Translates kie.ai's documented HTTP failure codes (401/402/404/422/
 * 429/5xx) into actionable strings so the worker's failure marker
 * tells the operator exactly what's wrong.
 */
export async function submitKieKlingAvatar(
  input: KieKlingAvatarSubmitInput,
): Promise<KieKlingAvatarSubmitResult> {
  const url = `${KIE_BASE}/jobs/createTask`;
  const modelId = getKieKlingAvatarModelId();
  const promptText = (input.prompt ?? '').slice(0, 5000);
  const body = {
    model: modelId,
    input: {
      image_url: input.imageUrl,
      audio_url: input.audioUrl,
      prompt: promptText,
    },
  };

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
      model: modelId,
      image_url_present: !!input.imageUrl,
      audio_url_present: !!input.audioUrl,
      prompt_chars: promptText.length,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    // Polish-19.0.3: log the FULL raw response body to console, not just
    // the translated short message. kie.ai's 5xx error bodies sometimes
    // carry nested detail (e.g. "prompt is required" returned as plain
    // text alongside an HTTP 500). Inngest captures stdout so this lands
    // in the worker's log stream without a code change to add diagnostics.
    console.log(
      `[kie-kling-avatar] submit transport failure: status=${result.status} ` +
        `model=${modelId} promptChars=${promptText.length} ` +
        `imageUrl=${input.imageUrl.slice(0, 80)}... audioUrl=${input.audioUrl.slice(0, 80)}... ` +
        `err=${result.errorMessage ?? 'unknown'}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieKlingAvatarErrorStatus(result.status, result.errorMessage),
    };
  }
  if (result.data.code !== undefined && result.data.code !== 200) {
    // Polish-19.0.3: dump the full wrapper body — kie.ai sometimes
    // returns soft failures with `code:200 + data:null` or odd shapes,
    // and the response wrapper itself carries hints we'd want to see.
    console.log(
      `[kie-kling-avatar] submit soft failure: model=${modelId} body=${JSON.stringify(result.data)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieKlingAvatarErrorStatus(result.data.code, result.data.msg),
    };
  }

  const taskId = result.data.data?.taskId ?? result.data.data?.task_id;
  if (!taskId) {
    console.log(
      `[kie-kling-avatar] submit succeeded but missing taskId; body=${JSON.stringify(result.data).slice(0, 1000)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'kie.ai createTask response missing taskId',
    };
  }
  return { ok: true, taskId, latencyMs: result.latencyMs };
}

export interface KieKlingAvatarPollInput {
  userId: string;
  apiKey: string;
  taskId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieKlingAvatarPollResult {
  ok: boolean;
  state?: KieKlingAvatarState;
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
 * polling loop (mirror of pollKieOmniTask). On any soft failure —
 * non-200 wrapper, missing data block, fail state — logs the raw
 * response body to console so a model-not-found / unknown-task /
 * shape-drift issue surfaces in Inngest logs without needing a
 * redeploy to add diagnostics.
 */
export async function pollKieKlingAvatar(
  input: KieKlingAvatarPollInput,
): Promise<KieKlingAvatarPollResult> {
  const url = `${KIE_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(input.taskId)}`;

  const result = await callProvider<{
    code?: number;
    msg?: string;
    data?: {
      taskId?: string;
      state?: KieKlingAvatarState;
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
    console.log(
      `[kie-kling-avatar] poll transport failure taskId=${input.taskId} status=${result.status} err=${result.errorMessage ?? 'unknown'}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieKlingAvatarErrorStatus(result.status, result.errorMessage),
    };
  }
  if (result.data.code !== undefined && result.data.code !== 200) {
    console.log(
      `[kie-kling-avatar] poll soft failure taskId=${input.taskId} body=${JSON.stringify(result.data).slice(0, 1000)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieKlingAvatarErrorStatus(result.data.code, result.data.msg),
    };
  }

  const data = result.data.data;
  if (!data) {
    console.log(
      `[kie-kling-avatar] poll missing data block taskId=${input.taskId} body=${JSON.stringify(result.data).slice(0, 1000)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'kie.ai recordInfo response missing data',
    };
  }

  const state = data.state;
  if (state === 'success') {
    const outputUrl = parseKlingAvatarOutputUrl(data.resultJson);
    return {
      ok: true,
      state: 'success',
      outputUrl,
      costTimeMs: data.costTime,
      latencyMs: result.latencyMs,
    };
  }
  if (state === 'fail') {
    // Mirror the kie-omni inference: failMsg can carry the bare code
    // when failCode is null. Log the full body so a new failure code
    // we haven't seen surfaces in logs the first time it hits.
    console.log(
      `[kie-kling-avatar] poll terminal fail taskId=${input.taskId} body=${JSON.stringify(result.data).slice(0, 1000)}`,
    );
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
  return {
    ok: true,
    state: state ?? 'waiting',
    latencyMs: result.latencyMs,
  };
}

/**
 * Extract `resultUrls[0]` from the JSON-stringified `resultJson` field.
 * Same shape as kie-omni — keeping a local helper rather than importing
 * across files to avoid coupling the two clients.
 */
export function parseKlingAvatarOutputUrl(raw: string | null | undefined): string | undefined {
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
 * Map kie.ai's documented HTTP-ish status codes to actionable strings.
 * Mirrors kie-omni.translateKieErrorStatus — kept local so the two
 * clients can drift independently if kie.ai adds product-specific
 * error semantics later (e.g., Avatar-specific validation messages).
 */
export function translateKieKlingAvatarErrorStatus(
  status: number | undefined,
  fallback: string | undefined,
): string {
  if (status === 401)
    return 'kie.ai authentication failed (invalid API key). Re-paste your key at /connections/tools.';
  if (status === 402) return 'kie.ai account has insufficient balance. Top up at kie.ai → Billing.';
  if (status === 404)
    return `kie.ai resource not found${fallback ? `: ${fallback}` : ''} (check the model id KIE_KLING_AVATAR_MODEL_ID).`;
  if (status === 422)
    return `kie.ai validation failed${fallback ? `: ${fallback}` : ' (check image_url, audio_url, prompt)'}.`;
  if (status === 429) return 'kie.ai rate limit hit. Retry in a few seconds.';
  if (typeof status === 'number' && status >= 500)
    return `kie.ai upstream error (HTTP ${status}${fallback ? `: ${fallback}` : ''}).`;
  return fallback ?? `kie.ai request failed${status ? ` (status ${status})` : ''}.`;
}
