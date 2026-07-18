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

describe('Polish-23 Commit 2: pollKieVeoLite — terminal states', () => {
  it('waiting → ok:true, no outputUrl', async () => {
    captureFetch({ status: 200, body: { code: 200, data: { state: 'waiting' } } });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('waiting');
    expect(r.outputUrl).toBeUndefined();
  });

  it('success + resultUrls[] → outputUrl extracted', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: { state: 'success', resultUrls: ['https://cdn.kie/veo/clip.mp4'], costTime: 47000 },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('success');
    expect(r.outputUrl).toBe('https://cdn.kie/veo/clip.mp4');
    expect(r.costTimeMs).toBe(47000);
  });

  it('success + JSON-encoded resultJson (legacy kie-video shape) → outputUrl extracted', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          state: 'success',
          resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie/veo/legacy.mp4'] }),
        },
      },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.outputUrl).toBe('https://cdn.kie/veo/legacy.mp4');
  });

  it('fail → ok:true (poll succeeded) but state=fail with failCode + failMsg', async () => {
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

  it('success with no output URLs → ok:true but errorMessage set (drift signal)', async () => {
    captureFetch({
      status: 200,
      body: { code: 200, data: { state: 'success' } },
    });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(true);
    expect(r.errorMessage).toMatch(/no output URL/i);
  });

  it('missing state → ok:false (shape drift)', async () => {
    captureFetch({ status: 200, body: { code: 200, data: {} } });
    const r = await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMessage).toMatch(/missing state/i);
  });

  it('GET URL uses /veo/record-info?taskId=…', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { state: 'waiting' } },
    });
    await pollKieVeoLite({ userId: 'u', apiKey: 'k', taskId: 't with spaces' });
    expect(calls[0]!.url).toBe(
      'https://api.kie.ai/api/v1/veo/record-info?taskId=t%20with%20spaces',
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer k');
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
