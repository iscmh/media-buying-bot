/**
 * Polish-12: kie.ai Gemini Omni Flash client — submit body shape,
 * recordInfo poll parsing (the resultJson STRING gotcha), and the
 * documented error-code translation.
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

describe('Polish-12: submitKieOmniVideo body shape', () => {
  it('POSTs to /api/v1/jobs/createTask with model=gemini-omni-video', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, msg: 'success', data: { taskId: 'task_abc' } },
    });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    const r = await submitKieOmniVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'A 30yo woman talking to camera',
    });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe('task_abc');
    expect(calls[0]!.url).toContain('/api/v1/jobs/createTask');
    const init = calls[0]!.init!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gemini-omni-video');
    expect(body.input.prompt).toMatch(/30yo woman/);
    expect(body.input.duration).toBe('10');
    expect(body.input.aspect_ratio).toBe('9:16');
    expect(body.input.resolution).toBe('1080p');
  });

  it('honors imageUrls + seed when provided', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 'task_xyz' } },
    });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    await submitKieOmniVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      imageUrls: ['https://x/ref.png'],
      seed: 42,
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.image_urls).toEqual(['https://x/ref.png']);
    expect(body.input.seed).toBe(42);
  });

  it('translates HTTP 401 → invalid API key', async () => {
    captureFetch({ status: 401, body: { code: 401, msg: 'unauthorized' } });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    const r = await submitKieOmniVideo({ userId: 'u', apiKey: 'bad', prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/invalid API key/i);
  });

  it('translates HTTP 402 → insufficient balance', async () => {
    captureFetch({ status: 402, body: { code: 402, msg: 'insufficient' } });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    const r = await submitKieOmniVideo({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.errorMessage).toMatch(/insufficient balance/i);
  });

  it('translates HTTP 422 → validation failed', async () => {
    captureFetch({ status: 422, body: { code: 422, msg: 'prompt too long' } });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    const r = await submitKieOmniVideo({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.errorMessage).toMatch(/validation failed/i);
  });

  it('translates HTTP 429 → rate limited', async () => {
    captureFetch({ status: 429, body: { code: 429, msg: 'rate limit' } });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    const r = await submitKieOmniVideo({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.errorMessage).toMatch(/rate limit/i);
  });

  it('treats a 200-wrapped non-success code as a soft failure', async () => {
    captureFetch({ status: 200, body: { code: 422, msg: 'invalid input' } });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    const r = await submitKieOmniVideo({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/validation failed/i);
  });

  it('returns ok=false when response omits taskId', async () => {
    captureFetch({ status: 200, body: { code: 200, data: {} } });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    const r = await submitKieOmniVideo({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/missing taskId/);
  });
});

describe('Polish-12: pollKieOmniTask parses resultJson STRING into resultUrls[0]', () => {
  it('state=success → outputUrl from JSON-parsed resultJson', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          taskId: 'task_abc',
          state: 'success',
          resultJson: JSON.stringify({
            resultUrls: ['https://static.aiquickdraw.com/result.mp4'],
          }),
          costTime: 67234,
        },
      },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    const r = await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 'task_abc' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('success');
    expect(r.outputUrl).toBe('https://static.aiquickdraw.com/result.mp4');
    expect(r.costTimeMs).toBe(67234);
  });

  it('state=fail → captures failCode + failMsg', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          taskId: 't',
          state: 'fail',
          failCode: 'CONTENT_POLICY',
          failMsg: 'flagged for review',
        },
      },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    const r = await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.state).toBe('fail');
    expect(r.failCode).toBe('CONTENT_POLICY');
    expect(r.failMsg).toBe('flagged for review');
  });

  it('Polish-12.2.2: failCode=null + failMsg=PUBLIC_ERROR_* identifier → inferred into failCode', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          taskId: 't',
          state: 'fail',
          failCode: null,
          failMsg: 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
        },
      },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    const r = await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.state).toBe('fail');
    expect(r.failCode).toBe('PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED');
    expect(r.failMsg).toBe('PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED');
  });

  it('Polish-12.2.2: failCode and failMsg both populated → dedicated field wins', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          taskId: 't',
          state: 'fail',
          failCode: 'CONTENT_POLICY',
          failMsg: 'something descriptive',
        },
      },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    const r = await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.failCode).toBe('CONTENT_POLICY');
    expect(r.failMsg).toBe('something descriptive');
  });

  it('Polish-12.2.2: failCode=null + failMsg as a prose sentence → failCode stays undefined', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: {
          taskId: 't',
          state: 'fail',
          failCode: null,
          failMsg: 'Generation failed due to safety',
        },
      },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    const r = await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.failCode).toBeUndefined();
    expect(r.failMsg).toBe('Generation failed due to safety');
  });

  it('state=waiting → returns waiting with no error', async () => {
    captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 't', state: 'waiting' } },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    const r = await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('waiting');
    expect(r.errorMessage).toBeUndefined();
  });

  it('success state with malformed resultJson → outputUrl undefined', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: { taskId: 't', state: 'success', resultJson: '{ this is not json' },
      },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    const r = await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.state).toBe('success');
    expect(r.outputUrl).toBeUndefined();
  });

  it('success state with empty resultUrls → outputUrl undefined', async () => {
    captureFetch({
      status: 200,
      body: {
        code: 200,
        data: { taskId: 't', state: 'success', resultJson: JSON.stringify({ resultUrls: [] }) },
      },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    const r = await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 't' });
    expect(r.outputUrl).toBeUndefined();
  });

  it('GETs /api/v1/jobs/recordInfo with taskId in query string', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 't', state: 'waiting' } },
    });
    const { pollKieOmniTask } = await import('../src/kie-omni');
    await pollKieOmniTask({ userId: 'u', apiKey: 'k', taskId: 'task_with spaces' });
    expect(calls[0]!.url).toContain('/api/v1/jobs/recordInfo?taskId=task_with%20spaces');
  });
});

describe('Polish-12: parseResultJsonOutputUrl', () => {
  it('extracts the first URL from a JSON string of {resultUrls}', async () => {
    const { parseResultJsonOutputUrl } = await import('../src/kie-omni');
    expect(parseResultJsonOutputUrl('{"resultUrls":["https://x/a.mp4","https://x/b.mp4"]}')).toBe(
      'https://x/a.mp4',
    );
  });

  it('returns undefined for null / undefined / non-string', async () => {
    const { parseResultJsonOutputUrl } = await import('../src/kie-omni');
    expect(parseResultJsonOutputUrl(null)).toBeUndefined();
    expect(parseResultJsonOutputUrl(undefined)).toBeUndefined();
    expect(parseResultJsonOutputUrl('')).toBeUndefined();
  });

  it('returns undefined for unparseable JSON', async () => {
    const { parseResultJsonOutputUrl } = await import('../src/kie-omni');
    expect(parseResultJsonOutputUrl('{ not json')).toBeUndefined();
  });

  it('returns undefined when resultUrls is missing / empty / non-array', async () => {
    const { parseResultJsonOutputUrl } = await import('../src/kie-omni');
    expect(parseResultJsonOutputUrl('{}')).toBeUndefined();
    expect(parseResultJsonOutputUrl('{"resultUrls":[]}')).toBeUndefined();
    expect(parseResultJsonOutputUrl('{"resultUrls":"not array"}')).toBeUndefined();
  });
});

describe('Polish-12: translateKieErrorStatus', () => {
  it('produces actionable messages for documented codes', async () => {
    const { translateKieErrorStatus } = await import('../src/kie-omni');
    expect(translateKieErrorStatus(401, undefined)).toMatch(/invalid API key/i);
    expect(translateKieErrorStatus(402, undefined)).toMatch(/insufficient balance/i);
    expect(translateKieErrorStatus(404, undefined)).toMatch(/resource not found/i);
    expect(translateKieErrorStatus(422, 'bad shape')).toMatch(/validation failed.*bad shape/i);
    expect(translateKieErrorStatus(429, undefined)).toMatch(/rate limit/i);
    expect(translateKieErrorStatus(500, undefined)).toMatch(/upstream error/i);
    expect(translateKieErrorStatus(undefined, 'unknown')).toBe('unknown');
  });
});

describe('Polish-12.4: submitKieOmniVideo characterIds plumbing', () => {
  it('includes character_ids on body.input when caller passes characterIds', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 'task_xyz' } },
    });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    await submitKieOmniVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      imageUrls: ['https://x/ref.png'],
      characterIds: ['char_abc'],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.character_ids).toEqual(['char_abc']);
  });

  it('omits character_ids from body.input when caller passes undefined (back-compat)', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 'task_xyz' } },
    });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    await submitKieOmniVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      imageUrls: ['https://x/ref.png'],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.character_ids).toBeUndefined();
  });

  it('truncates character_ids to kie.ai max of 3 when caller passes more', async () => {
    const calls = captureFetch({
      status: 200,
      body: { code: 200, data: { taskId: 't' } },
    });
    const { submitKieOmniVideo } = await import('../src/kie-omni');
    await submitKieOmniVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      characterIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.character_ids).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('Polish-12.4: createKieOmniCharacter', () => {
  it('POSTs the documented body shape to /omni/character/create', async () => {
    const calls = captureFetch({
      status: 200,
      body: {
        code: 200,
        msg: 'success',
        data: {
          characterId: 'b09dbf56_abc',
          characterName: 'ad_character',
          imageUrl: 'https://kie.ai/cached.png',
        },
      },
    });
    const { createKieOmniCharacter } = await import('../src/kie-omni');
    const r = await createKieOmniCharacter({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://supa/ref.png',
      characterDescription: 'A 30yo woman with dark hair.',
      characterName: 'ad_character',
    });
    expect(r.ok).toBe(true);
    expect(r.characterId).toBe('b09dbf56_abc');
    expect(r.characterName).toBe('ad_character');
    expect(r.imageUrl).toBe('https://kie.ai/cached.png');
    expect(calls[0]!.url).toContain('/api/v1/omni/character/create');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.description).toBe('A 30yo woman with dark hair.');
    expect(body.image_urls).toEqual(['https://supa/ref.png']);
    expect(body.character_name).toBe('ad_character');
  });

  it('returns ok=false when response is 200 OK but characterId is missing', async () => {
    captureFetch({
      status: 200,
      body: { code: 200, data: { characterName: 'x' } },
    });
    const { createKieOmniCharacter } = await import('../src/kie-omni');
    const r = await createKieOmniCharacter({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://x/r.png',
      characterDescription: 'd',
      characterName: 'n',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/missing characterId/);
  });

  it('translates 402 insufficient balance', async () => {
    captureFetch({
      status: 402,
      body: { code: 402, msg: 'insufficient' },
    });
    const { createKieOmniCharacter } = await import('../src/kie-omni');
    const r = await createKieOmniCharacter({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://x/r.png',
      characterDescription: 'd',
      characterName: 'n',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/insufficient balance/i);
  });

  it('treats a 200-wrapped non-success code as a soft failure', async () => {
    captureFetch({
      status: 200,
      body: { code: 422, msg: 'image too large' },
    });
    const { createKieOmniCharacter } = await import('../src/kie-omni');
    const r = await createKieOmniCharacter({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://x/r.png',
      characterDescription: 'd',
      characterName: 'n',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/validation failed/i);
  });

  it('translates 401 invalid API key', async () => {
    captureFetch({
      status: 401,
      body: { code: 401, msg: 'unauthorized' },
    });
    const { createKieOmniCharacter } = await import('../src/kie-omni');
    const r = await createKieOmniCharacter({
      userId: 'u',
      apiKey: 'bad',
      imageUrl: 'https://x/r.png',
      characterDescription: 'd',
      characterName: 'n',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/invalid API key/i);
  });
});
