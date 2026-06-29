/**
 * Polish-19: kie.ai Kling Avatar v2 client tests. Verify submit body
 * shape, recordInfo poll parsing (same resultJson STRING gotcha as
 * Omni Flash), failure-code inference, and the env-overridable model id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('Polish-19: submitKieKlingAvatar body shape', () => {
  it('POSTs to /api/v1/jobs/createTask with model=kling/ai-avatar-pro by default', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, msg: 'success', data: { taskId: 'kt_abc' } },
    });
    const { submitKieKlingAvatar } = await import('../src/kie-kling-avatar');
    const r = await submitKieKlingAvatar({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://example.com/face.png',
      audioUrl: 'https://example.com/voice.mp3',
    });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe('kt_abc');
    expect(calls[0]!.url).toContain('/api/v1/jobs/createTask');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.model).toBe('kling/ai-avatar-pro');
    expect(body.input.image_url).toBe('https://example.com/face.png');
    expect(body.input.audio_url).toBe('https://example.com/voice.mp3');
    expect(body.input.prompt).toBe(''); // always present, defaults to empty string per docs
  });

  it('respects KIE_KLING_AVATAR_MODEL_ID env override', async () => {
    process.env.KIE_KLING_AVATAR_MODEL_ID = 'kling/ai-avatar-standard';
    captureFetch({
      status: 200,
      body: { code: 200, msg: 'success', data: { taskId: 't' } },
    });
    const { submitKieKlingAvatar } = await import('../src/kie-kling-avatar');
    await submitKieKlingAvatar({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://x/i.png',
      audioUrl: 'https://x/a.mp3',
    });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.model).toBe('kling/ai-avatar-standard');
  });

  it('passes the prompt through, truncated to 5000 chars per docs', async () => {
    captureFetch({
      status: 200,
      body: { code: 200, msg: 'success', data: { taskId: 't' } },
    });
    const { submitKieKlingAvatar } = await import('../src/kie-kling-avatar');
    const huge = 'A'.repeat(6000);
    await submitKieKlingAvatar({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://x/i.png',
      audioUrl: 'https://x/a.mp3',
      prompt: huge,
    });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect((body.input.prompt as string).length).toBe(5000);
  });

  it('returns the kie.ai soft-failure code translated into an actionable message', async () => {
    captureFetch({
      status: 200,
      body: { code: 402, msg: 'Insufficient credit', data: null },
    });
    const { submitKieKlingAvatar } = await import('../src/kie-kling-avatar');
    const r = await submitKieKlingAvatar({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://x/i.png',
      audioUrl: 'https://x/a.mp3',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/insufficient balance/i);
  });

  it('returns a model-id hint when kie.ai answers 404 on createTask', async () => {
    captureFetch({
      status: 200,
      body: { code: 404, msg: 'Model not found', data: null },
    });
    const { submitKieKlingAvatar } = await import('../src/kie-kling-avatar');
    const r = await submitKieKlingAvatar({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://x/i.png',
      audioUrl: 'https://x/a.mp3',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/KIE_KLING_AVATAR_MODEL_ID/);
  });
});

describe('Polish-19: pollKieKlingAvatar parses recordInfo response', () => {
  it('GETs /api/v1/jobs/recordInfo with taskId in query string', async () => {
    const calls = captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: { state: 'waiting', resultJson: null, failCode: null, failMsg: null },
      },
    });
    const { pollKieKlingAvatar } = await import('../src/kie-kling-avatar');
    const r = await pollKieKlingAvatar({ userId: 'u', apiKey: 'k', taskId: 'kt_xyz' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('waiting');
    expect(calls[0]!.url).toContain('/api/v1/jobs/recordInfo?taskId=kt_xyz');
  });

  it('extracts resultUrls[0] from the JSON-stringified resultJson on success', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          state: 'success',
          resultJson: JSON.stringify({
            resultUrls: ['https://cdn.kie.ai/out/abc.mp4', 'https://cdn.kie.ai/out/def.mp4'],
          }),
          failCode: null,
          failMsg: null,
        },
      },
    });
    const { pollKieKlingAvatar } = await import('../src/kie-kling-avatar');
    const r = await pollKieKlingAvatar({ userId: 'u', apiKey: 'k', taskId: 'kt' });
    expect(r.state).toBe('success');
    expect(r.outputUrl).toBe('https://cdn.kie.ai/out/abc.mp4');
  });

  it('infers the bare failCode from failMsg when kie.ai returns the code inverted', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          state: 'fail',
          resultJson: null,
          failCode: null,
          failMsg: 'PUBLIC_ERROR_SAFETY_FILTER_FAILED',
        },
      },
    });
    const { pollKieKlingAvatar } = await import('../src/kie-kling-avatar');
    const r = await pollKieKlingAvatar({ userId: 'u', apiKey: 'k', taskId: 'kt' });
    expect(r.state).toBe('fail');
    expect(r.failCode).toBe('PUBLIC_ERROR_SAFETY_FILTER_FAILED');
  });

  it('returns undefined outputUrl when resultJson is malformed', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          state: 'success',
          resultJson: '{not-json',
          failCode: null,
          failMsg: null,
        },
      },
    });
    const { pollKieKlingAvatar } = await import('../src/kie-kling-avatar');
    const r = await pollKieKlingAvatar({ userId: 'u', apiKey: 'k', taskId: 'kt' });
    expect(r.outputUrl).toBeUndefined();
  });
});

describe('Polish-19: estimateKieKlingAvatarCostUsd', () => {
  it('matches kie.ai Pro list pricing: $0.115 per second of output', async () => {
    const { estimateKieKlingAvatarCostUsd } = await import('../src/kie-kling-avatar');
    expect(estimateKieKlingAvatarCostUsd(30)).toBeCloseTo(3.45, 5);
    expect(estimateKieKlingAvatarCostUsd(60)).toBeCloseTo(6.9, 5);
    expect(estimateKieKlingAvatarCostUsd(0)).toBe(0);
    expect(estimateKieKlingAvatarCostUsd(-5)).toBe(0);
  });

  it('respects KIE_KLING_AVATAR_USD_PER_SECOND env override', async () => {
    process.env.KIE_KLING_AVATAR_USD_PER_SECOND = '0.05';
    const { estimateKieKlingAvatarCostUsd } = await import('../src/kie-kling-avatar');
    expect(estimateKieKlingAvatarCostUsd(30)).toBeCloseTo(1.5, 5);
  });
});

describe('Polish-19: parseKlingAvatarOutputUrl edge cases', () => {
  it('handles null, undefined, empty, and non-JSON inputs', async () => {
    const { parseKlingAvatarOutputUrl } = await import('../src/kie-kling-avatar');
    expect(parseKlingAvatarOutputUrl(null)).toBeUndefined();
    expect(parseKlingAvatarOutputUrl(undefined)).toBeUndefined();
    expect(parseKlingAvatarOutputUrl('')).toBeUndefined();
    expect(parseKlingAvatarOutputUrl('not-json')).toBeUndefined();
    expect(parseKlingAvatarOutputUrl(JSON.stringify({ resultUrls: [] }))).toBeUndefined();
    expect(parseKlingAvatarOutputUrl(JSON.stringify({ resultUrls: [''] }))).toBeUndefined();
    expect(parseKlingAvatarOutputUrl(JSON.stringify({}))).toBeUndefined();
  });
});
