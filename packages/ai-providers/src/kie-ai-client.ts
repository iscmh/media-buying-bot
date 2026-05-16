import { computeKieAiCost } from '@mbb/shared';
import { callProvider } from './chokepoint';

/**
 * DEPRECATED Phase 3f — Kie.ai (Sora 2) video generation client.
 *
 * UGC pipeline now defaults to HeyGen Avatar Mode (cheaper, faster, more
 * reliable for talking-head ads). This module stays so any stale jobs in
 * the Inngest queue can drain — but no new code path selects 'kie_ai'
 * for UGC generation. Form layer auto-picks 'heygen' on submit.
 *
 * If we ever want full-scene generative video back (vs talking-avatar),
 * this is the entry point — flip the form picker back on and bump the
 * version. Keeping the integration warm is cheap.
 *
 * --- Original Phase 3b documentation ---
 * Async — submit returns a task ID, caller polls until video is ready.
 *
 * Endpoints (verified against kie.ai docs, May 2025):
 *   - POST /api/v1/sora-2/generate           — submit; returns { taskId }
 *   - GET  /api/v1/sora-2/status?taskId=...  — poll; returns { status, videoUrl? }
 *
 * Auth: `Authorization: Bearer <apiKey>`.
 */

const KIE_BASE = 'https://api.kie.ai/api/v1';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;

export interface KieSubmitInput {
  userId: string;
  apiKey: string;
  prompt: string;
  /** Sora video duration in seconds. Default 15. */
  durationSeconds?: number;
  /** "9:16" | "1:1" | "16:9". Default 9:16 for UGC. */
  aspectRatio?: '9:16' | '1:1' | '16:9';
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieSubmitResult {
  ok: boolean;
  taskId?: string;
  latencyMs: number;
  errorMessage?: string;
}

/** Submit a generation request. Returns the task ID for polling. */
export async function submitKieAiVideo(input: KieSubmitInput): Promise<KieSubmitResult> {
  const url = `${KIE_BASE}/sora-2/generate`;
  const body = {
    prompt: input.prompt,
    duration: input.durationSeconds ?? 15,
    aspect_ratio: input.aspectRatio ?? '9:16',
  };

  const result = await callProvider<{
    code?: number;
    msg?: string;
    data?: { taskId?: string; task_id?: string };
    taskId?: string;
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
      prompt_chars: input.prompt.length,
      duration: body.duration,
      aspect_ratio: body.aspect_ratio,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    };
  }

  // Their API has changed shape between releases; accept any of the common
  // forms.
  const taskId = result.data.taskId ?? result.data.data?.taskId ?? result.data.data?.task_id;

  if (!taskId) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'Kie.ai response did not include a task ID',
    };
  }

  return { ok: true, taskId, latencyMs: result.latencyMs };
}

export interface KieCheckInput {
  userId: string;
  apiKey: string;
  taskId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export type KieTaskStatus = 'processing' | 'completed' | 'failed';

export interface KieCheckResult {
  status: KieTaskStatus;
  videoUrl?: string;
  /** Cost only counted on first 'completed' check, by convention — caller tracks. */
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

/** Single status check. Caller composes with `step.sleep` for polling. */
export async function checkKieAiVideoStatus(input: KieCheckInput): Promise<KieCheckResult> {
  const url = `${KIE_BASE}/sora-2/status?taskId=${encodeURIComponent(input.taskId)}`;

  const result = await callProvider<{
    code?: number;
    msg?: string;
    data?: {
      status?: string;
      videoUrl?: string;
      video_url?: string;
      errorMessage?: string;
    };
    status?: string;
    videoUrl?: string;
  }>({
    userId: input.userId,
    provider: 'kie_ai',
    url,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { taskId: input.taskId },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      status: 'failed',
      costUsd: 0,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    };
  }

  const data = result.data.data ?? result.data;
  const rawStatus = (data.status ?? '').toLowerCase();
  const videoUrl =
    (data as { videoUrl?: string; video_url?: string }).videoUrl ??
    (data as { video_url?: string }).video_url;

  let status: KieTaskStatus;
  if (rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'succeeded') {
    status = 'completed';
  } else if (rawStatus === 'failed' || rawStatus === 'error') {
    status = 'failed';
  } else {
    status = 'processing';
  }

  return {
    status,
    videoUrl,
    costUsd: status === 'completed' ? computeKieAiCost() : 0,
    latencyMs: result.latencyMs,
    errorMessage:
      status === 'failed'
        ? ((data as { errorMessage?: string }).errorMessage ?? 'Kie.ai task failed')
        : undefined,
  };
}
