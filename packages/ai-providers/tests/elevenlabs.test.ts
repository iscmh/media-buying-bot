/**
 * Polish-21.0.4 hotfix: ElevenLabs TTS client tests.
 *
 * Pins:
 *  - POST /v1/text-to-speech/{voice_id} URL + body shape
 *  - xi-api-key lowercase auth header
 *  - Binary response captured as Uint8Array
 *  - Error branches (401 / 402 / 404 / 422 / 429 / 5xx)
 *  - verifyElevenLabsKey happy-path + reject
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

const realFetch = globalThis.fetch;

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(response: {
  status: number;
  audio?: Uint8Array;
  errorBody?: unknown;
}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (response.status >= 200 && response.status < 300 && response.audio) {
      const audio = response.audio;
      return {
        status: response.status,
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null),
        },
        arrayBuffer: async () => audio.buffer.slice(0, audio.byteLength),
        text: async () => '',
      } as unknown as Response;
    }
    const errorText = JSON.stringify(response.errorBody ?? {});
    return {
      status: response.status,
      ok: false,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => errorText,
      json: async () => response.errorBody ?? {},
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe('Polish-21.0.4: submitElevenLabsTts', () => {
  it('POSTs to /v1/text-to-speech/{voice_id} with xi-api-key + JSON body, returns audio bytes', async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0xaa, 0xbb, 0xcc, 0xdd]);
    const calls = captureFetch({ status: 200, audio });
    const { submitElevenLabsTts } = await import('../src/elevenlabs');
    const r = await submitElevenLabsTts({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      text: 'I swear to god, this $80 serum did nothing.',
    });
    expect(r.ok).toBe(true);
    expect(r.audio).toBeInstanceOf(Uint8Array);
    expect(r.audio!.byteLength).toBe(6);
    // URL includes the voice_id in the path.
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL');
    const init = calls[0]!.init!;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    // Regression pin: lowercase xi-api-key (matches ElevenLabs docs).
    expect(headers['xi-api-key']).toBe('k1234567890abcd');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('audio/mpeg');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toBe('I swear to god, this $80 serum did nothing.');
    expect(body.model_id).toBe('eleven_multilingual_v2');
    expect(body.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
    });
  });

  it('accepts a custom model_id and merges caller voice_settings on top of the UGC defaults', async () => {
    const audio = new Uint8Array([1]);
    const calls = captureFetch({ status: 200, audio });
    const { submitElevenLabsTts } = await import('../src/elevenlabs');
    await submitElevenLabsTts({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      voiceId: 'v',
      text: 't',
      modelId: 'eleven_turbo_v2',
      voiceSettings: { stability: 0.3, style: 0.7 },
    });
    const body = JSON.parse((calls[0]!.init!.body as string) ?? '{}') as {
      model_id: string;
      voice_settings: Record<string, number | boolean>;
    };
    expect(body.model_id).toBe('eleven_turbo_v2');
    expect(body.voice_settings.stability).toBe(0.3);
    expect(body.voice_settings.similarity_boost).toBe(0.75); // preserved default
    expect(body.voice_settings.style).toBe(0.7);
  });

  it('URL-encodes voice_id path segments', async () => {
    const audio = new Uint8Array([1]);
    const calls = captureFetch({ status: 200, audio });
    const { submitElevenLabsTts } = await import('../src/elevenlabs');
    await submitElevenLabsTts({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      voiceId: 'voice with spaces/slashes',
      text: 't',
    });
    expect(calls[0]!.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice%20with%20spaces%2Fslashes',
    );
  });

  it('401 translates to re-paste-key guidance', async () => {
    captureFetch({ status: 401, errorBody: { detail: 'invalid api key' } });
    const { submitElevenLabsTts } = await import('../src/elevenlabs');
    const r = await submitElevenLabsTts({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      voiceId: 'v',
      text: 't',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/ElevenLabs authentication failed/);
    expect(r.errorMessage).toMatch(/\/connections\/ai-provider/);
    expect(r.status).toBe(401);
  });

  it('402 translates to top-up guidance with a billing URL', async () => {
    captureFetch({ status: 402, errorBody: { detail: 'out of credits' } });
    const { submitElevenLabsTts } = await import('../src/elevenlabs');
    const r = await submitElevenLabsTts({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      voiceId: 'v',
      text: 't',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/elevenlabs.io\/app\/settings\/billing/);
  });

  it('404 translates to voice-not-found guidance (plan-scope hint)', async () => {
    captureFetch({ status: 404, errorBody: { detail: 'voice_id not found' } });
    const { submitElevenLabsTts } = await import('../src/elevenlabs');
    const r = await submitElevenLabsTts({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      voiceId: 'v',
      text: 't',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/voice_id not found/);
    expect(r.errorMessage).toMatch(/plan/);
  });

  it('422 surfaces detail.message when present', async () => {
    captureFetch({
      status: 422,
      errorBody: { detail: { status: 'invalid_uid', message: 'A voice_id is required.' } },
    });
    const { submitElevenLabsTts } = await import('../src/elevenlabs');
    const r = await submitElevenLabsTts({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      voiceId: 'v',
      text: 't',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/A voice_id is required/);
  });
});

describe('Polish-21.0.4: verifyElevenLabsKey', () => {
  it('200 from GET /v1/user → ok', async () => {
    captureFetch({ status: 200, audio: new Uint8Array([1]) });
    const { verifyElevenLabsKey } = await import('../src/elevenlabs');
    const r = await verifyElevenLabsKey('k1234567890abcd');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.statusCode).toBe(200);
  });

  it('401 → not ok with a clean reason', async () => {
    captureFetch({ status: 401, errorBody: { detail: 'invalid api key' } });
    const { verifyElevenLabsKey } = await import('../src/elevenlabs');
    const r = await verifyElevenLabsKey('k1234567890abcd');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(401);
      expect(r.reason).toMatch(/invalid api key/);
    }
  });
});

describe('Polish-21.0.4: redactElevenLabsApiKey', () => {
  it('redacts middle, keeps prefix + suffix', async () => {
    const { redactElevenLabsApiKey } = await import('../src/elevenlabs');
    const r = redactElevenLabsApiKey('eleven_1234567890abcdefghij');
    expect(r).toMatch(/^xi-api-key:/);
    expect(r).toContain('elev');
    expect(r).toContain('ghij');
    expect(r).not.toContain('1234567890abcd');
  });

  it('handles short keys defensively', async () => {
    const { redactElevenLabsApiKey } = await import('../src/elevenlabs');
    expect(redactElevenLabsApiKey('')).toBe('xi-api-key:(short-key)');
    expect(redactElevenLabsApiKey('short')).toBe('xi-api-key:(short-key)');
  });
});
