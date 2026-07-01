/**
 * Polish-20 Commit 2: kie-video client tests. Verifies the config-
 * driven serialization (Kling's STRING duration vs Seedance's number,
 * `sound` vs `generate_audio`, imageField names), the poll parser +
 * resultJson unwrap, error translation, model-id env override, and
 * the rate-limit retry loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelProviderConfig } from '@mbb/shared';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

const realFetch = globalThis.fetch;
const realEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...realEnv };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = realEnv;
  vi.clearAllMocks();
});

function captureFetch(response: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      status: response.status,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

describe('Polish-20: submitKieVideo per-config serialization', () => {
  it('Seedance 1.5 Pro: duration as NUMBER, audio field is `generate_audio`, imageField is `input_urls`', async () => {
    const config = getModelProviderConfig('seedance_1_5_pro', 'kie_ai')!;
    captureFetch({
      status: 200,
      body: { code: 200, msg: 'success', data: { taskId: 't-s15pro' } },
    });
    const { submitKieVideo } = await import('../src/kie-video');
    const r = await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'She says: "I swear to god..."',
      durationSeconds: 8,
      aspectRatio: '9:16',
      audio: true,
      imageUrls: ['https://example.com/a.png'],
    });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe('t-s15pro');
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.model).toBe('bytedance/seedance-1.5-pro');
    expect(body.input.duration).toBe(8); // NUMBER
    expect(typeof body.input.duration).toBe('number');
    expect(body.input.generate_audio).toBe(true);
    expect(body.input.input_urls).toEqual(['https://example.com/a.png']);
    // Extras merged in:
    expect(body.input.fixed_lens).toBe(true);
    expect(body.input.resolution).toBe('720p');
    expect(body.input.aspect_ratio).toBe('9:16');
  });

  it('Kling 3.0: duration as STRING enum, audio field is `sound`, imageField is `image_urls`, NO resolution field', async () => {
    const config = getModelProviderConfig('kling_3_standard', 'kie_ai')!;
    captureFetch({ status: 200, body: { code: 200, msg: 'success', data: { taskId: 't-kling' } } });
    const { submitKieVideo } = await import('../src/kie-video');
    await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'She says: "..."',
      durationSeconds: 15,
      aspectRatio: '9:16',
      audio: true,
      imageUrls: ['https://example.com/frame0.png'],
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.model).toBe('kling-3.0/video');
    // Docs: duration is a STRING enum ("3".."15").
    expect(body.input.duration).toBe('15');
    expect(typeof body.input.duration).toBe('string');
    // Docs: audio flag is `sound`, NOT `generate_audio`.
    expect(body.input.sound).toBe(true);
    expect(body.input.generate_audio).toBeUndefined();
    // Docs: image field is `image_urls`.
    expect(body.input.image_urls).toEqual(['https://example.com/frame0.png']);
    // Docs: NO `resolution` field — 720p derived from mode + aspect_ratio.
    expect(body.input.resolution).toBeUndefined();
    // Extras: mode + multi_shots hardcoded for UGC single-shot.
    expect(body.input.mode).toBe('std');
    expect(body.input.multi_shots).toBe(false);
  });

  it('Seedance 2: imageField is `reference_image_urls`, duration as NUMBER, resolution 720p', async () => {
    const config = getModelProviderConfig('seedance_2', 'kie_ai')!;
    captureFetch({ status: 200, body: { code: 200, msg: 'success', data: { taskId: 't-s2' } } });
    const { submitKieVideo } = await import('../src/kie-video');
    await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'p',
      durationSeconds: 15,
      imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.model).toBe('bytedance/seedance-2');
    expect(body.input.reference_image_urls).toEqual([
      'https://example.com/a.png',
      'https://example.com/b.png',
    ]);
    expect(body.input.duration).toBe(15);
    expect(typeof body.input.duration).toBe('number');
    expect(body.input.resolution).toBe('720p');
  });

  it('omits imageField when caller passes no image URLs', async () => {
    const config = getModelProviderConfig('seedance_1_5_pro', 'kie_ai')!;
    captureFetch({ status: 200, body: { code: 200, msg: 'success', data: { taskId: 't' } } });
    const { submitKieVideo } = await import('../src/kie-video');
    await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'p',
      durationSeconds: 8,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.input.input_urls).toBeUndefined();
  });

  it('POSTs to the same createTask endpoint across all three models', async () => {
    for (const modelId of ['seedance_1_5_pro', 'kling_3_standard', 'seedance_2'] as const) {
      const config = getModelProviderConfig(modelId, 'kie_ai')!;
      const calls = captureFetch({
        status: 200,
        body: { code: 200, msg: 'success', data: { taskId: 't' } },
      });
      const { submitKieVideo } = await import('../src/kie-video');
      await submitKieVideo({
        userId: 'u',
        apiKey: 'k',
        config,
        prompt: 'p',
        durationSeconds: 8,
      });
      expect(calls[0]!.url).toBe('https://api.kie.ai/api/v1/jobs/createTask');
    }
  });

  it('translates 400 into a kie.ai validation-failed hint', async () => {
    const config = getModelProviderConfig('kling_3_standard', 'kie_ai')!;
    captureFetch({ status: 200, body: { code: 400, msg: 'invalid duration' } });
    const { submitKieVideo } = await import('../src/kie-video');
    const r = await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'p',
      durationSeconds: 8,
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/validation failed/);
  });

  it('translates 402 into an insufficient-balance hint', async () => {
    const config = getModelProviderConfig('seedance_2', 'kie_ai')!;
    captureFetch({ status: 200, body: { code: 402, msg: 'not enough credits' } });
    const { submitKieVideo } = await import('../src/kie-video');
    const r = await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'p',
      durationSeconds: 8,
    });
    expect(r.errorMessage).toMatch(/Insufficient kie\.ai balance/);
  });
});

describe('Polish-20: getKieVideoModelIdOverride env hatch', () => {
  it('returns the default modelParam when no env override is set', async () => {
    const { getKieVideoModelIdOverride } = await import('../src/kie-video');
    delete process.env.KIE_MODEL_ID_OVERRIDE_BYTEDANCE_SEEDANCE_1_5_PRO;
    expect(getKieVideoModelIdOverride('bytedance/seedance-1.5-pro')).toBe(
      'bytedance/seedance-1.5-pro',
    );
  });

  it('honors env override keyed by upper-snake-cased model param', async () => {
    process.env.KIE_MODEL_ID_OVERRIDE_BYTEDANCE_SEEDANCE_1_5_PRO = 'bytedance/seedance-1.5-pro-v2';
    const { getKieVideoModelIdOverride } = await import('../src/kie-video');
    expect(getKieVideoModelIdOverride('bytedance/seedance-1.5-pro')).toBe(
      'bytedance/seedance-1.5-pro-v2',
    );
  });

  it('handles slashes / dots / hyphens in the model param when building env keys', async () => {
    process.env.KIE_MODEL_ID_OVERRIDE_KLING_3_0_VIDEO = 'kling-3.1/video';
    const { getKieVideoModelIdOverride } = await import('../src/kie-video');
    expect(getKieVideoModelIdOverride('kling-3.0/video')).toBe('kling-3.1/video');
  });
});

describe('Polish-20: pollKieVideo parses recordInfo responses', () => {
  it('returns state=waiting when kie.ai has not finished yet', async () => {
    captureFetch({
      status: 200,
      body: { code: 200, msg: 'success', data: { taskId: 't', state: 'waiting' } },
    });
    const { pollKieVideo } = await import('../src/kie-video');
    const r = await pollKieVideo({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('waiting');
    expect(r.outputUrl).toBeUndefined();
  });

  it('parses resultJson STRING and extracts the first resultUrls entry on success', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          taskId: 't',
          state: 'success',
          resultJson: JSON.stringify({
            resultUrls: [
              'https://static.aiquickdraw.com/tools/example/out.mp4',
              'https://static.aiquickdraw.com/tools/example/out2.mp4',
            ],
          }),
          costTime: 42_000,
        },
      },
    });
    const { pollKieVideo } = await import('../src/kie-video');
    const r = await pollKieVideo({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.state).toBe('success');
    expect(r.outputUrl).toBe('https://static.aiquickdraw.com/tools/example/out.mp4');
    expect(r.costTimeMs).toBe(42_000);
  });

  it('surfaces failMsg + failCode on state=fail', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          taskId: 't',
          state: 'fail',
          failCode: 'GEN_ERROR',
          failMsg: 'model refused',
        },
      },
    });
    const { pollKieVideo } = await import('../src/kie-video');
    const r = await pollKieVideo({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.state).toBe('fail');
    expect(r.failCode).toBe('GEN_ERROR');
    expect(r.failMsg).toBe('model refused');
  });

  it('flags success-without-resultJson as a recoverable drift', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: { taskId: 't', state: 'success', resultJson: null },
      },
    });
    const { pollKieVideo } = await import('../src/kie-video');
    const r = await pollKieVideo({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.state).toBe('success');
    expect(r.outputUrl).toBeUndefined();
    expect(r.errorMessage).toMatch(/resultJson missing/);
  });
});

describe('Polish-20: parseResultJsonOutputUrl edge cases', () => {
  it('returns undefined for null / empty / malformed input', async () => {
    const { parseResultJsonOutputUrl } = await import('../src/kie-video');
    expect(parseResultJsonOutputUrl(null)).toBeUndefined();
    expect(parseResultJsonOutputUrl(undefined)).toBeUndefined();
    expect(parseResultJsonOutputUrl('')).toBeUndefined();
    expect(parseResultJsonOutputUrl('not json')).toBeUndefined();
    expect(parseResultJsonOutputUrl('{"resultUrls":[]}')).toBeUndefined();
    expect(parseResultJsonOutputUrl('{"resultUrls":[""]}')).toBeUndefined();
    expect(parseResultJsonOutputUrl('{"otherShape":true}')).toBeUndefined();
  });
});

describe('Polish-20: detectKieVideoRateLimit', () => {
  it('matches HTTP 429, kie code 429, and message substrings', async () => {
    const { detectKieVideoRateLimit } = await import('../src/kie-video');
    expect(detectKieVideoRateLimit(429, undefined, undefined)).toBe(true);
    expect(detectKieVideoRateLimit(undefined, 429, undefined)).toBe(true);
    expect(detectKieVideoRateLimit(undefined, undefined, 'kie.ai rate limit hit.')).toBe(true);
    expect(detectKieVideoRateLimit(undefined, undefined, 'Quota Exceeded for project')).toBe(true);
    expect(detectKieVideoRateLimit(undefined, undefined, 'Too Many Requests')).toBe(true);
  });

  it('returns false for validation / auth / server errors', async () => {
    const { detectKieVideoRateLimit } = await import('../src/kie-video');
    expect(detectKieVideoRateLimit(400, 400, 'validation failed')).toBe(false);
    expect(detectKieVideoRateLimit(401, 401, 'authentication failed')).toBe(false);
    expect(detectKieVideoRateLimit(500, 500, 'upstream error')).toBe(false);
  });
});

describe('Polish-20: computeKieVideoRateLimitBackoffMs curve', () => {
  it('emits [10, 20, 40, 60, 60]s cap', async () => {
    const { computeKieVideoRateLimitBackoffMs } = await import('../src/kie-video');
    expect(computeKieVideoRateLimitBackoffMs(0)).toBe(10_000);
    expect(computeKieVideoRateLimitBackoffMs(1)).toBe(20_000);
    expect(computeKieVideoRateLimitBackoffMs(2)).toBe(40_000);
    expect(computeKieVideoRateLimitBackoffMs(3)).toBe(60_000);
    expect(computeKieVideoRateLimitBackoffMs(4)).toBe(60_000);
    expect(computeKieVideoRateLimitBackoffMs(100)).toBe(60_000);
  });

  it('clamps non-finite / negative to the initial interval', async () => {
    const { computeKieVideoRateLimitBackoffMs } = await import('../src/kie-video');
    expect(computeKieVideoRateLimitBackoffMs(NaN)).toBe(10_000);
    expect(computeKieVideoRateLimitBackoffMs(-1)).toBe(10_000);
    expect(computeKieVideoRateLimitBackoffMs(Infinity)).toBe(10_000);
  });
});

describe('Polish-20: submitKieVideo retries on rate-limit responses', () => {
  async function importWithFastSleep() {
    const mod = await import('../src/kie-video');
    mod.__setKieVideoSleepImplForTests(() => Promise.resolve());
    mod.__resetKieVideoFirstCallLogForTests();
    return mod;
  }
  afterEach(async () => {
    const mod = await import('../src/kie-video');
    mod.__restoreKieVideoSleepImplForTests();
  });

  it('retries once on kie code 429 then succeeds', async () => {
    const config = getModelProviderConfig('seedance_1_5_pro', 'kie_ai')!;
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          status: 200,
          text: async () => JSON.stringify({ code: 429, msg: 'rate limit' }),
        } as Response;
      }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ code: 200, msg: 'success', data: { taskId: 't-retry-ok' } }),
      } as Response;
    }) as typeof globalThis.fetch;

    const { submitKieVideo } = await importWithFastSleep();
    const r = await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'p',
      durationSeconds: 8,
    });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe('t-retry-ok');
    expect(call).toBe(2);
  });

  it('exhausts retries and surfaces the retry-count in the errorMessage', async () => {
    process.env.KIE_VIDEO_RATE_LIMIT_MAX_RETRIES = '2';
    const config = getModelProviderConfig('seedance_1_5_pro', 'kie_ai')!;
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      return {
        status: 200,
        text: async () => JSON.stringify({ code: 429, msg: 'rate limit' }),
      } as Response;
    }) as typeof globalThis.fetch;

    const { submitKieVideo } = await importWithFastSleep();
    const r = await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'p',
      durationSeconds: 8,
    });
    expect(r.ok).toBe(false);
    expect(call).toBe(3); // initial + 2 retries
    expect(r.errorMessage).toMatch(/hit after 3 attempts/);
    expect(r.errorMessage).toMatch(/KIE_VIDEO_RATE_LIMIT_MAX_RETRIES/);
  });

  it('does NOT retry on non-rate-limit failures (400 returns immediately)', async () => {
    const config = getModelProviderConfig('seedance_1_5_pro', 'kie_ai')!;
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      return {
        status: 200,
        text: async () => JSON.stringify({ code: 400, msg: 'bad prompt' }),
      } as Response;
    }) as typeof globalThis.fetch;

    const { submitKieVideo } = await importWithFastSleep();
    const r = await submitKieVideo({
      userId: 'u',
      apiKey: 'k',
      config,
      prompt: 'p',
      durationSeconds: 8,
    });
    expect(r.ok).toBe(false);
    expect(call).toBe(1);
  });
});
