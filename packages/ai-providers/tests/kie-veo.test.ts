/**
 * Polish-23 Commit 2: kie.ai Veo 3.1 Lite client tests.
 * Pins:
 *   - endpoint URL (/veo/generate) + Bearer auth
 *   - request body shape (model, input.prompt, input.aspectRatio,
 *     input.duration, optional input.imageUrls)
 *   - default model string = 'veo3_lite' (BCH anchor)
 *   - poll response parsing (waiting / success / fail)
 *   - success extracts outputUrl from either resultUrls[0] OR
 *     JSON-encoded resultJson (drift tolerance)
 *   - error translation (400/401/402/404/422/429/5xx)
 *   - rate-limit retry (429 body / substring surfaces)
 *   - cost constants match Polish-23 spec ($0.175/clip, 35 credits, 8s)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import {
  __resetKieVeoFirstCallLogForTests,
  __restoreKieVeoSleepImplForTests,
  __setKieVeoSleepImplForTests,
  buildKieVeoRequestBody,
  classifyKieVeoErrorKind,
  computeKieVeoRateLimitBackoffMs,
  detectKieVeoRateLimit,
  isKieVeoTransientErrorMessage,
  KIE_VEO_TRANSIENT_ERROR_MESSAGE_PATTERNS,
  mapKieVeoSuccessFlag,
  estimateKieVeoLiteClipCostUsd,
  extractVeoOutputUrl,
  getKieVeoLiteUsdPerClip,
  getKieVeoRateLimitMaxRetries,
  getVeoLiteModelId,
  KIE_VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES,
  KIE_VEO_LITE_DEFAULT_CLIP_SECONDS,
  KIE_VEO_LITE_DEFAULT_CREDITS_PER_CLIP,
  KIE_VEO_LITE_DEFAULT_USD_PER_CLIP,
  pollKieVeoLite,
  submitKieVeoLite,
  translateKieVeoErrorStatus,
  VEO_LITE_DEFAULT_MODEL_ID,
} from '../src/kie-veo';

const realFetch = globalThis.fetch;
beforeEach(() => {
  __resetKieVeoFirstCallLogForTests();
  __setKieVeoSleepImplForTests(async () => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __restoreKieVeoSleepImplForTests();
  vi.clearAllMocks();
});

interface CapturedCall {
  url: string;
  init?: RequestInit;
}
function captureFetch(response: { status: number; body: unknown }): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

describe('Polish-23 Commit 2: submitKieVeoLite — endpoint + auth + body shape', () => {
  it('POSTs the dedicated /veo/generate URL with Bearer auth', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 'task-abc' } },
    });
    const r = await submitKieVeoLite({
      userId: 'u',
      apiKey: 'sk-kie-example',
      prompt: 'CHARACTER LOCK — Linda talking selfie…',
      imageUrls: ['https://cdn.example/higgsfield-linda.png'],
    });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe('task-abc');
    expect(calls[0]!.url).toBe('https://api.kie.ai/api/v1/veo/generate');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-kie-example');
    expect(headers['content-type']).toBe('application/json');
  });

  it('body is FLAT (no `input` wrapper) — model=veo3_fast + prompt + aspect_ratio + imageUrls at top level', async () => {
    // Polish-23 Commit 3.0.7: kie.ai's /veo/generate endpoint takes
    // fields at the top level, NOT under an input wrapper. Doc URL:
    // https://docs.kie.ai/veo3-api/generate-veo-3-video
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 'task-1' } },
    });
    await submitKieVeoLite({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      imageUrls: ['https://cdn/x.png'],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    // Regression pin: NEVER regenerate the input:{…} wrapper — that
    // was the exact wire-shape bug from the first-live test.
    expect(body).not.toHaveProperty('input');
    expect(body.model).toBe('veo3_fast');
    expect(body.prompt).toBe('p');
    expect(body.aspect_ratio).toBe('9:16');
    expect(body.imageUrls).toEqual(['https://cdn/x.png']);
    // NO duration field — Veo 3.1 clips are fixed 8s server-side.
    expect(body).not.toHaveProperty('duration');
    // NO camelCase aspectRatio.
    expect(body).not.toHaveProperty('aspectRatio');
  });

  it("body carries generationType='REFERENCE_2_VIDEO' when imageUrls present (image-to-video path)", async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 't' } },
    });
    await submitKieVeoLite({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      imageUrls: ['https://cdn/x.png'],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.generationType).toBe('REFERENCE_2_VIDEO');
  });

  it("body carries generationType='TEXT_2_VIDEO' when no imageUrls (text-only path)", async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 't' } },
    });
    await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.generationType).toBe('TEXT_2_VIDEO');
    expect(body).not.toHaveProperty('imageUrls');
  });

  it('body carries stable enableFallback=false + enableTranslation=true defaults', async () => {
    const calls = captureFetch({ status: 200, body: { code: 200, data: { taskId: 't' } } });
    await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.enableFallback).toBe(false);
    expect(body.enableTranslation).toBe(true);
  });

  it('matches the documented curl example shape verbatim (kie.ai docs regression pin)', async () => {
    // The kie.ai docs curl example body — this test pins the
    // superset shape so any future refactor that drifts from the
    // documented example fails loudly. Example URL:
    // https://docs.kie.ai/veo3-api/generate-veo-3-video
    const calls = captureFetch({ status: 200, body: { code: 200, data: { taskId: 't' } } });
    await submitKieVeoLite({
      userId: 'u',
      apiKey: 'k',
      prompt: 'A dog playing in a park',
      imageUrls: ['http://example.com/image1.jpg'],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toEqual({
      prompt: 'A dog playing in a park',
      imageUrls: ['http://example.com/image1.jpg'],
      model: 'veo3_fast',
      aspect_ratio: '9:16',
      enableFallback: false,
      enableTranslation: true,
      generationType: 'REFERENCE_2_VIDEO',
    });
  });

  it('accepts task_id alias in the response (kie.ai has drifted the field name)', async () => {
    captureFetch({ status: 200, body: { code: 200, data: { task_id: 'task-snake' } } });
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe('task-snake');
  });

  it('surfaces missing-taskId as an ok:false error (defensive against shape drift)', async () => {
    captureFetch({ status: 200, body: { code: 200, data: {} } });
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMessage).toMatch(/missing taskId/i);
  });

  it('soft failure: code=402 (insufficient balance) translates to a re-topup hint', async () => {
    captureFetch({ status: 200, body: { code: 402, msg: 'balance too low' } });
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMessage).toMatch(/insufficient kie\.ai balance/i);
  });
});

describe('Polish-23 Commit 3.0.11: pollKieVeoLite — real kie.ai shape (successFlag + data.response.resultUrls)', () => {
  it("REAL LIVE CAPTURED shape from operator's job 5f31a1c4: successFlag=0 + response=null → state='waiting'", async () => {
    // This body is the verbatim wire response the operator's
    // Commit-3.0.9 forensics captured. It's the source of truth
    // for what kie.ai actually returns during Veo generation.
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          taskId: 'veo3_lite_task_abc',
          paramJson: '{"prompt":"…"}',
          completeTime: null,
          response: null,
          successFlag: 0,
          errorCode: null,
          errorMessage: null,
          createTime: 1752825253000,
          fallbackFlag: false,
        },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('waiting');
    expect(r.outputUrl).toBeUndefined();
  });

  it("successFlag=1 with data.response.resultUrls populated → state='success' + outputUrl extracted", async () => {
    // The docs example shape (docs.kie.ai/veo3-api/get-veo-3-video-details).
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          taskId: 'veo3_lite_task_xyz',
          completeTime: 1752825350000,
          response: {
            taskId: 'veo3_lite_task_xyz',
            resultUrls: ['http://example.com/video1.mp4'],
            originUrls: ['http://example.com/original.mp4'],
            resolution: '1080p',
          },
          successFlag: 1,
          errorCode: null,
          errorMessage: '',
          createTime: 1752825253000,
          fallbackFlag: false,
        },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('success');
    expect(r.outputUrl).toBe('http://example.com/video1.mp4');
  });

  it("successFlag=2 with errorCode + errorMessage → state='fail' + failCode + failMsg", async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          taskId: 'veo3_lite_task_bad',
          successFlag: 2,
          errorCode: 'CONTENT_POLICY',
          errorMessage: 'prompt violated guardrails',
          response: null,
        },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('fail');
    expect(r.failCode).toBe('CONTENT_POLICY');
    expect(r.failMsg).toBe('prompt violated guardrails');
    expect(r.errorKind).toBe('terminal');
  });

  it("successFlag=1 with NO response.resultUrls → state='success' but errorMessage set (drift signal)", async () => {
    captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 't', successFlag: 1, response: {} } },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('success');
    expect(r.errorMessage).toMatch(/no output URL/i);
  });

  it('missing successFlag AND missing legacy state → ok:false shape-drift diagnostic', async () => {
    captureFetch({ status: 200, body: { code: 200, data: { taskId: 't' } } });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMessage).toMatch(/missing successFlag/i);
  });

  it("legacy state='fail' fallback still works (belt-and-suspenders for pre-3.0.11 shape regressions)", async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: { state: 'fail', failCode: 'BAD_INPUT', failMsg: 'prompt too short' },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('fail');
    expect(r.failCode).toBe('BAD_INPUT');
    expect(r.failMsg).toBe('prompt too short');
  });

  it("legacy state='success' + top-level resultUrls fallback still works", async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: { state: 'success', resultUrls: ['https://cdn.legacy/clip.mp4'] },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.outputUrl).toBe('https://cdn.legacy/clip.mp4');
  });

  it('GET URL uses /veo/record-info?taskId=…', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { successFlag: 0 } },
    });
    await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't with spaces' });
    expect(calls[0]!.url).toBe(
      'https://api.kie.ai/api/v1/veo/record-info?taskId=t%20with%20spaces',
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer k');
  });
});

describe('Polish-23 Commit 3.0.21: mapKieVeoSuccessFlag — verified live decode table', () => {
  it('1 → success (Success; extract output URL)', () => {
    expect(mapKieVeoSuccessFlag(1)).toBe('success');
  });
  it('0 → waiting (Processing / queued; keep polling)', () => {
    expect(mapKieVeoSuccessFlag(0)).toBe('waiting');
  });
  it('2 → waiting (LIVE-observed mid-flight state, NOT terminal failure)', () => {
    // Regression pin: pre-3.0.21 treated 2 as fail. Live evidence
    // (task 878a16b…) showed 2/3 as healthy in-flight states.
    expect(mapKieVeoSuccessFlag(2)).toBe('waiting');
  });
  it('3 → waiting (LIVE-observed on task 878a16b…, keep polling)', () => {
    expect(mapKieVeoSuccessFlag(3)).toBe('waiting');
  });
  it('4/5 → fail (rare edge, treat as terminal)', () => {
    expect(mapKieVeoSuccessFlag(4)).toBe('fail');
    expect(mapKieVeoSuccessFlag(5)).toBe('fail');
    expect(mapKieVeoSuccessFlag(99)).toBe('fail');
  });
  it('errorCode populated (string) → fail regardless of successFlag', () => {
    expect(mapKieVeoSuccessFlag(0, 'IMAGE_INVALID')).toBe('fail');
    expect(mapKieVeoSuccessFlag(1, 'MODERATION_BLOCK')).toBe('fail');
    expect(mapKieVeoSuccessFlag(3, 'STORAGE_UPLOAD_FAIL')).toBe('fail');
  });
  it('errorCode populated (nonzero number) → fail regardless of successFlag', () => {
    expect(mapKieVeoSuccessFlag(0, 400)).toBe('fail');
    expect(mapKieVeoSuccessFlag(1, 500)).toBe('fail');
  });
  it('errorCode falsy (null / undefined / "0" / 0 / empty string) → does NOT override', () => {
    // Regression pin: successFlag 1 with a zero-ish errorCode still
    // means success. kie.ai occasionally emits errorCode:"0" or
    // errorCode:0 as a placeholder — that's not a real failure.
    expect(mapKieVeoSuccessFlag(1, null)).toBe('success');
    expect(mapKieVeoSuccessFlag(1, undefined)).toBe('success');
    expect(mapKieVeoSuccessFlag(1, '0')).toBe('success');
    expect(mapKieVeoSuccessFlag(1, 0)).toBe('success');
    expect(mapKieVeoSuccessFlag(1, '')).toBe('success');
  });
  it('unknown / missing successFlag → null (caller surfaces shape-drift diagnostic)', () => {
    expect(mapKieVeoSuccessFlag(null)).toBe(null);
    expect(mapKieVeoSuccessFlag(undefined)).toBe(null);
    expect(mapKieVeoSuccessFlag('1')).toBe(null); // strict numeric — no coercion
    expect(mapKieVeoSuccessFlag(-1)).toBe(null);
  });
});

describe('Polish-23 Commit 3.0.22: isKieVeoTransientErrorMessage — pattern matcher', () => {
  it('matches the operator-specified patterns case-insensitively', () => {
    expect(isKieVeoTransientErrorMessage('Internal Error, Please try again later')).toBe(true);
    expect(isKieVeoTransientErrorMessage('INTERNAL ERROR')).toBe(true);
    expect(isKieVeoTransientErrorMessage('service temporarily unavailable')).toBe(true);
    expect(isKieVeoTransientErrorMessage('Service Temporarily Unavailable')).toBe(true);
    expect(isKieVeoTransientErrorMessage('Timeout waiting for GPU')).toBe(true);
    expect(isKieVeoTransientErrorMessage('Queue full — retry shortly')).toBe(true);
    expect(isKieVeoTransientErrorMessage('Rate limit hit')).toBe(true);
    expect(isKieVeoTransientErrorMessage('Please try again later')).toBe(true);
  });
  it('exposes the exact pattern list so tests + operator SQL know the surface', () => {
    // Regression pin: any addition/removal of a pattern must be
    // deliberate — production interpretation of kie.ai flakiness
    // hinges on this list.
    expect(KIE_VEO_TRANSIENT_ERROR_MESSAGE_PATTERNS).toEqual([
      'internal error',
      'try again later',
      'service temporarily unavailable',
      'timeout',
      'queue full',
      'rate limit',
    ]);
  });
  it('does NOT match genuine terminal errors', () => {
    expect(isKieVeoTransientErrorMessage('Content policy violation')).toBe(false);
    expect(isKieVeoTransientErrorMessage('Invalid prompt')).toBe(false);
    expect(isKieVeoTransientErrorMessage('Insufficient balance')).toBe(false);
    expect(isKieVeoTransientErrorMessage('Authentication failed')).toBe(false);
    expect(isKieVeoTransientErrorMessage('')).toBe(false);
    expect(isKieVeoTransientErrorMessage(null)).toBe(false);
    expect(isKieVeoTransientErrorMessage(undefined)).toBe(false);
    expect(isKieVeoTransientErrorMessage(42)).toBe(false);
    expect(isKieVeoTransientErrorMessage({ msg: 'internal error' })).toBe(false);
  });
});

describe('Polish-23 Commit 3.0.22: pollKieVeoLite — transient errorMessage DOWNGRADE integration', () => {
  it("successFlag=2 + errorMessage='Internal Error, Please try again later' + errorCode=null → state='waiting' (DOWNGRADED)", async () => {
    // This is the EXACT failure body from job 02544a64 (operator's
    // production evidence). Under 3.0.21 this already returned
    // 'waiting' via mapKieVeoSuccessFlag; under 3.0.22 it stays
    // 'waiting' AND the downgrade path is a defense-in-depth
    // even if successFlag drifts to a value the flag mapper
    // treats as fail.
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          taskId: 'veo3_lite_task_02544a64',
          successFlag: 2,
          errorMessage: 'Internal Error, Please try again later',
          errorCode: null,
          response: null,
        },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-02544a64' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('waiting');
  });
  it("successFlag=4 + errorMessage='Service temporarily unavailable' + errorCode=null → state='waiting' (DOWNGRADED)", async () => {
    // Belt-and-suspenders pin: even the successFlag≥4 fail branch
    // gets the transient downgrade when errorMessage matches.
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          successFlag: 4,
          errorMessage: 'Service temporarily unavailable',
          errorCode: null,
        },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('waiting');
  });
  it("successFlag=4 + errorMessage='Content policy violation' + errorCode=null → state='fail' (NOT downgraded)", async () => {
    // Non-transient errorMessage — the fail stays terminal so the
    // worker's clip-level auto-retry (Commit 3.0.22 Part 2) can
    // decide whether to resubmit.
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          successFlag: 4,
          errorMessage: 'Content policy violation',
          errorCode: null,
        },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('fail');
    expect(r.errorKind).toBe('terminal');
  });
  it("errorCode='CONTENT_POLICY' + errorMessage='Internal Error' → state='fail' (errorCode OVERRIDES pattern)", async () => {
    // Regression pin per operator spec: "errorCode always overrides
    // (agent's existing pattern from 3.0.21)". A real errorCode
    // beats any transient phrasing.
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          successFlag: 2,
          errorMessage: 'Internal Error, Please try again later',
          errorCode: 'CONTENT_POLICY',
        },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('fail');
    expect(r.errorKind).toBe('terminal');
    expect(r.failCode).toBe('CONTENT_POLICY');
  });
});

describe('Polish-23 Commit 2: extractVeoOutputUrl — dual shape tolerance', () => {
  it('prefers resultUrls[0] when both are present', () => {
    const u = extractVeoOutputUrl(
      ['https://a.mp4'],
      JSON.stringify({ resultUrls: ['https://b.mp4'] }),
    );
    expect(u).toBe('https://a.mp4');
  });

  it('falls back to resultJson when resultUrls is null / empty', () => {
    expect(extractVeoOutputUrl(null, JSON.stringify({ resultUrls: ['https://b.mp4'] }))).toBe(
      'https://b.mp4',
    );
    expect(extractVeoOutputUrl([], JSON.stringify({ resultUrls: ['https://b.mp4'] }))).toBe(
      'https://b.mp4',
    );
  });

  it('returns undefined when resultJson is malformed', () => {
    expect(extractVeoOutputUrl(null, '{not json')).toBeUndefined();
  });

  it('returns undefined when both surfaces are empty', () => {
    expect(extractVeoOutputUrl(null, null)).toBeUndefined();
    expect(extractVeoOutputUrl(undefined, undefined)).toBeUndefined();
  });
});

describe('Polish-23 Commit 2: translateKieVeoErrorStatus', () => {
  it('402 mentions the 35-credit Veo Lite cost + kie.ai/api-key top-up path', () => {
    const m = translateKieVeoErrorStatus(402, 'balance too low');
    expect(m).toMatch(/insufficient kie\.ai balance/i);
    expect(m).toMatch(/35 credits/);
  });

  it('401 sends the operator to /connections/tools (not /connections/ai-provider)', () => {
    expect(translateKieVeoErrorStatus(401, undefined)).toMatch(/\/connections\/tools/);
  });

  it('5xx surfaces status code and passes fallback through', () => {
    expect(translateKieVeoErrorStatus(503, 'service_unavailable')).toMatch(
      /Veo upstream error \(HTTP 503: service_unavailable\)/,
    );
  });

  it('unknown status uses fallback when provided', () => {
    expect(translateKieVeoErrorStatus(undefined, 'boom')).toBe('boom');
  });
});

describe('Polish-23 Commit 2: rate-limit primitives (Polish-19.4.3 pattern)', () => {
  it('default retries = 5', () => {
    expect(KIE_VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES).toBe(5);
    expect(getKieVeoRateLimitMaxRetries()).toBe(5);
  });

  it('backoff curve: [10, 20, 40, 60, 60]s (2^n capped at 60s)', () => {
    expect(computeKieVeoRateLimitBackoffMs(0)).toBe(10_000);
    expect(computeKieVeoRateLimitBackoffMs(1)).toBe(20_000);
    expect(computeKieVeoRateLimitBackoffMs(2)).toBe(40_000);
    expect(computeKieVeoRateLimitBackoffMs(3)).toBe(60_000);
    expect(computeKieVeoRateLimitBackoffMs(4)).toBe(60_000);
  });

  it('detects rate limits via HTTP 429, kie body code 429, and message substrings', () => {
    expect(detectKieVeoRateLimit(429, undefined, undefined)).toBe(true);
    expect(detectKieVeoRateLimit(undefined, 429, undefined)).toBe(true);
    expect(detectKieVeoRateLimit(undefined, undefined, 'rate limit hit')).toBe(true);
    expect(detectKieVeoRateLimit(undefined, undefined, 'Quota exceeded for you')).toBe(true);
    expect(detectKieVeoRateLimit(undefined, undefined, 'Too many requests')).toBe(true);
    expect(detectKieVeoRateLimit(500, undefined, 'boom')).toBe(false);
  });

  it('submitKieVeoLite retries on soft-429 body code then succeeds', async () => {
    let attempt = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempt++;
      const body =
        attempt < 3
          ? { code: 429, msg: 'rate limit' }
          : { code: 200, data: { taskId: 'task-late' } };
      return {
        status: 200,
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as typeof globalThis.fetch;
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe('task-late');
    expect(attempt).toBe(3);
  });

  it('non-rate-limit failures return immediately (no retry)', async () => {
    let attempt = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempt++;
      const body = { code: 400, msg: 'bad prompt' };
      return {
        status: 200,
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as typeof globalThis.fetch;
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(attempt).toBe(1);
  });
});

describe('Polish-23 Commit 3.0.6: classifyKieVeoErrorKind — terminal vs transient triage', () => {
  it('HTTP 429 → transient', () => {
    expect(classifyKieVeoErrorKind(429, undefined, undefined)).toBe('transient');
  });

  it('HTTP 5xx → transient', () => {
    expect(classifyKieVeoErrorKind(500, undefined, undefined)).toBe('transient');
    expect(classifyKieVeoErrorKind(503, undefined, undefined)).toBe('transient');
  });

  it('HTTP 400/401/402/404/422 → terminal', () => {
    for (const s of [400, 401, 402, 404, 422]) {
      expect(classifyKieVeoErrorKind(s, undefined, undefined)).toBe('terminal');
    }
  });

  it('body-code 429 → transient', () => {
    expect(classifyKieVeoErrorKind(undefined, 429, undefined)).toBe('transient');
  });

  it('body-code 400/401/402/404/422 → terminal', () => {
    for (const c of [400, 401, 402, 404, 422]) {
      expect(classifyKieVeoErrorKind(undefined, c, undefined)).toBe('terminal');
    }
  });

  it("'Please enter prompt' substring → terminal (the exact failure surface from the first-live report)", () => {
    expect(classifyKieVeoErrorKind(undefined, undefined, 'Please enter prompt')).toBe('terminal');
  });

  it('rate-limit / upstream-error substrings → transient', () => {
    expect(classifyKieVeoErrorKind(undefined, undefined, 'rate limit hit')).toBe('transient');
    expect(classifyKieVeoErrorKind(undefined, undefined, 'kie.ai upstream error')).toBe(
      'transient',
    );
    expect(classifyKieVeoErrorKind(undefined, undefined, 'too many requests')).toBe('transient');
  });

  it('balance / auth / not-found / missing-shape substrings → terminal', () => {
    expect(classifyKieVeoErrorKind(undefined, undefined, 'Insufficient kie.ai balance')).toBe(
      'terminal',
    );
    expect(classifyKieVeoErrorKind(undefined, undefined, 'kie.ai authentication failed')).toBe(
      'terminal',
    );
    expect(classifyKieVeoErrorKind(undefined, undefined, 'resource not found')).toBe('terminal');
    expect(classifyKieVeoErrorKind(undefined, undefined, 'missing taskId')).toBe('terminal');
    expect(classifyKieVeoErrorKind(undefined, undefined, 'missing state field')).toBe('terminal');
  });

  it('unknown / unclassifiable → terminal (fail-fast default; safer than blind retries)', () => {
    expect(classifyKieVeoErrorKind(undefined, undefined, undefined)).toBe('terminal');
    expect(classifyKieVeoErrorKind(undefined, undefined, 'some novel error message')).toBe(
      'terminal',
    );
  });

  it('body-code 5xx → transient (Commit 3.0.15: kie.ai upstream hiccup, not schema drift)', () => {
    // Regression pin for the operator's Julia-4-clips run: clip 4
    // poll returned {code:500, msg:"Internal Server Error"} and
    // the pre-3.0.15 classifier tagged it terminal — fired
    // NonRetriableError on a genuinely transient kie.ai hiccup.
    expect(classifyKieVeoErrorKind(undefined, 500, 'Internal Server Error')).toBe('transient');
    expect(classifyKieVeoErrorKind(undefined, 502, 'Bad Gateway')).toBe('transient');
    expect(classifyKieVeoErrorKind(undefined, 503, 'Service Unavailable')).toBe('transient');
    expect(classifyKieVeoErrorKind(undefined, 504, 'Gateway Timeout')).toBe('transient');
  });
});

describe('Polish-23 Commit 3.0.15: poll missing data envelope → transient (not terminal)', () => {
  it("code:500 wrapper without data envelope → ok:false + errorKind='transient'", async () => {
    const body = { code: 500, msg: 'Internal Server Error' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response) as typeof globalThis.fetch;
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('transient');
      expect(r.errorMessage).toMatch(/upstream error/i);
    }
  });

  it('code:200 wrapper with null data envelope → transient (retry-able)', async () => {
    const body = { code: 200, msg: 'success', data: null };
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response) as typeof globalThis.fetch;
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('transient');
      expect(r.errorMessage).toMatch(/missing data envelope/i);
    }
  });
});

describe('Polish-23 Commit 3.0.8: rawErrorBody attached on every failure path', () => {
  it('submit HTTP-level failure surfaces raw response body', async () => {
    const body = { code: 400, msg: 'Please enter prompt', data: { field: 'prompt' } };
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 400,
      ok: false,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response) as typeof globalThis.fetch;
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rawErrorBody).toBeDefined();
      // rawBody surfaces the parsed JSON kie.ai returned — pin the
      // .data.field so the operator's SQL can drill into the
      // validator complaint directly.
      expect(r.rawErrorBody).toMatchObject({
        code: 400,
        msg: 'Please enter prompt',
        data: { field: 'prompt' },
      });
    }
  });

  it('submit body-code failure surfaces the wrapped {code, msg, data} response', async () => {
    const body = { code: 402, msg: 'balance too low' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response) as typeof globalThis.fetch;
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rawErrorBody).toMatchObject({ code: 402, msg: 'balance too low' });
    }
  });

  it('poll HTTP-level failure surfaces raw body', async () => {
    const body = { error: 'bad taskId' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 400,
      ok: false,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response) as typeof globalThis.fetch;
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rawErrorBody).toBeDefined();
    }
  });

  it("poll state='fail' surfaces the data payload with failCode + failMsg", async () => {
    const body = {
      code: 200,
      data: { state: 'fail', failCode: 'CONTENT_POLICY', failMsg: 'nsfw guardrail' },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response) as typeof globalThis.fetch;
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('fail');
    expect(r.rawErrorBody).toMatchObject({
      code: 200,
      data: { state: 'fail', failCode: 'CONTENT_POLICY' },
    });
  });
});

describe('Polish-23 Commit 3.0.6: submit/poll results carry errorKind on the failure path', () => {
  it("submit HTTP 400 attaches errorKind='terminal'", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 400,
      ok: false,
      json: async () => ({ msg: 'Please enter prompt' }),
      text: async () => JSON.stringify({ msg: 'Please enter prompt' }),
    } as Response) as typeof globalThis.fetch;
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('terminal');
  });

  it("submit body-code 429 attaches errorKind='transient'", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ code: 429, msg: 'rate limit' }),
      text: async () => JSON.stringify({ code: 429, msg: 'rate limit' }),
    })) as typeof globalThis.fetch;
    // Trigger no-retry path by setting KIE_VEO_RATE_LIMIT_MAX_RETRIES=0
    // via env — but that env leaks, so instead use the retry loop
    // and check the LAST failing result's errorKind.
    __setKieVeoSleepImplForTests(async () => {});
    const r = await submitKieVeoLite({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('transient');
    __restoreKieVeoSleepImplForTests();
  });

  it("poll state='fail' attaches errorKind='terminal'", async () => {
    const body = {
      code: 200,
      data: { state: 'fail', failCode: 'BAD_INPUT', failMsg: 'bad prompt' },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response) as typeof globalThis.fetch;
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('fail');
    expect(r.errorKind).toBe('terminal');
  });
});

describe('Polish-23 Commit 3.0.4: buildKieVeoRequestBody — pure body builder for worker-side forensics', () => {
  it('produces the SAME shape submit sends to kie.ai (zero-drift capture)', async () => {
    // Round-trip pin: build the body eagerly, then submit → assert
    // fetch received exactly the eagerly-built body.
    const eager = buildKieVeoRequestBody({
      userId: 'u',
      apiKey: 'k',
      prompt: 'CHARACTER LOCK — Linda selfie',
      imageUrls: ['https://cdn/x.png'],
      durationSeconds: 8,
    });
    const calls = captureFetch({ status: 200, body: { code: 200, data: { taskId: 't' } } });
    await submitKieVeoLite({
      userId: 'u',
      apiKey: 'k',
      prompt: 'CHARACTER LOCK — Linda selfie',
      imageUrls: ['https://cdn/x.png'],
    });
    const wireBody = JSON.parse(calls[0]!.init!.body as string);
    expect(wireBody).toEqual(eager);
  });

  it('carries flat top-level fields: model=veo3_fast + prompt + aspect_ratio + imageUrls (no `input` wrapper)', () => {
    const b = buildKieVeoRequestBody({
      userId: 'u',
      apiKey: 'k',
      prompt: 'test prompt',
      imageUrls: ['https://cdn/x.png'],
    });
    expect(b).not.toHaveProperty('input');
    expect(b['model']).toBe('veo3_fast');
    expect(b['prompt']).toBe('test prompt');
    expect(b['aspect_ratio']).toBe('9:16');
    expect(b['imageUrls']).toEqual(['https://cdn/x.png']);
    expect(b['generationType']).toBe('REFERENCE_2_VIDEO');
    // NO duration field (Veo clips are fixed 8s server-side).
    expect(b).not.toHaveProperty('duration');
    // NO camelCase aspectRatio.
    expect(b).not.toHaveProperty('aspectRatio');
  });

  it('omits imageUrls when none provided (text-only Veo clip) + generationType=TEXT_2_VIDEO', () => {
    const b = buildKieVeoRequestBody({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(b).not.toHaveProperty('imageUrls');
    expect(b['generationType']).toBe('TEXT_2_VIDEO');
  });

  it('respects caller-provided aspectRatio override (converted to snake_case aspect_ratio wire field)', () => {
    const b = buildKieVeoRequestBody({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      aspectRatio: '16:9',
    });
    expect(b['aspect_ratio']).toBe('16:9');
  });
});

describe('Polish-23 Commit 2: model + cost constants (BCH anchors)', () => {
  it("default model string is veo3_fast (kie.ai's documented Fast tier — Commit 3.0.7 corrected the BCH-conflated `veo3_lite` string)", () => {
    // Docs: https://docs.kie.ai/veo3-api/generate-veo-3-video
    // Only `veo3` (Quality) and `veo3_fast` (Fast) are documented.
    // `veo3_lite` was a Commit 2 assumption that didn't match the
    // API surface. BCH's $0.175/clip cost matches the Fast tier.
    expect(VEO_LITE_DEFAULT_MODEL_ID).toBe('veo3_fast');
    expect(getVeoLiteModelId()).toBe('veo3_fast');
  });

  it('default cost is $0.175 per 8s clip (35 credits × $0.005)', () => {
    expect(KIE_VEO_LITE_DEFAULT_USD_PER_CLIP).toBe(0.175);
    expect(KIE_VEO_LITE_DEFAULT_CLIP_SECONDS).toBe(8);
    expect(KIE_VEO_LITE_DEFAULT_CREDITS_PER_CLIP).toBe(35);
    expect(getKieVeoLiteUsdPerClip()).toBe(0.175);
  });

  it("BCH's 60s-ad Veo-only anchor: 8 clips × $0.175 = $1.40", () => {
    expect(estimateKieVeoLiteClipCostUsd(8)).toBeCloseTo(1.4, 5);
  });

  it('estimator floors negative / fractional clip counts safely', () => {
    expect(estimateKieVeoLiteClipCostUsd(-3)).toBe(0);
    expect(estimateKieVeoLiteClipCostUsd(2.9)).toBeCloseTo(0.35, 5);
  });
});
