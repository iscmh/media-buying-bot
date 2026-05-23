/**
 * Polish-4: ElevenLabs TTS client. Verifies the request shape + base64
 * encoding of the audio body + cost estimate.
 *
 * Mocks: global fetch + @mbb/db audit logger (dynamic-imported in the
 * client, but vitest's vi.mock hoists).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import {
  estimateElevenLabsCostUsd,
  estimateVoiceoverVariantCostUsd,
  getDefaultElevenLabsVoiceId,
  submitElevenLabsTts,
} from '../src/elevenlabs';

const realFetch = globalThis.fetch;
const realEnv = process.env;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = realEnv;
  vi.clearAllMocks();
});

function mockAudioFetchOnce(opts: { status?: number; bytes?: Uint8Array; errorBody?: string }) {
  const audioBytes = opts.bytes ?? new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x10]);
  globalThis.fetch = vi.fn().mockResolvedValue({
    status: opts.status ?? 200,
    headers: { get: (k: string) => (k === 'content-type' ? 'audio/mpeg' : null) },
    arrayBuffer: async () => audioBytes.buffer,
    text: async () => opts.errorBody ?? '',
  } as unknown as Response) as typeof globalThis.fetch;
}

function captureFetch(opts: { bytes?: Uint8Array; status?: number }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const audioBytes = opts.bytes ?? new Uint8Array([0xff, 0xfb]);
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      status: opts.status ?? 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => audioBytes.buffer,
      text: async () => '',
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

describe('Polish-4: submitElevenLabsTts', () => {
  it('POSTs to /v1/text-to-speech/{voice_id} with xi-api-key + voice_settings', async () => {
    const calls = captureFetch({ status: 200 });
    const r = await submitElevenLabsTts({
      userId: 'u',
      apiKey: 'eleven_key_123',
      text: 'Hello, this is a test voiceover.',
      voiceId: 'voice_42',
    });
    expect(r.ok).toBe(true);
    expect(r.audioBase64).toBeDefined();
    expect(calls[0]!.url).toContain('/v1/text-to-speech/voice_42');
    expect((calls[0]!.init!.headers as Record<string, string>)['xi-api-key']).toBe(
      'eleven_key_123',
    );
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.text).toBe('Hello, this is a test voiceover.');
    expect(body.model_id).toBe('eleven_multilingual_v2');
    expect(body.voice_settings).toBeDefined();
  });

  it('falls back to ELEVENLABS_DEFAULT_VOICE_ID when no voice provided', async () => {
    process.env = { ...realEnv, ELEVENLABS_DEFAULT_VOICE_ID: 'env_voice_99' };
    const calls = captureFetch({ status: 200 });
    await submitElevenLabsTts({ userId: 'u', apiKey: 'k', text: 'hi' });
    expect(calls[0]!.url).toContain('env_voice_99');
  });

  it('returns ok=false on 401 with the error body excerpt', async () => {
    mockAudioFetchOnce({ status: 401, errorBody: '{"detail":"invalid key"}' });
    const r = await submitElevenLabsTts({ userId: 'u', apiKey: 'bad', text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(401);
    expect(r.errorMessage).toMatch(/invalid key/);
  });

  it('produces a base64 string of the returned audio bytes', async () => {
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    mockAudioFetchOnce({ status: 200, bytes });
    const r = await submitElevenLabsTts({ userId: 'u', apiKey: 'k', text: 'hi' });
    expect(r.ok).toBe(true);
    // base64 of bytes 0x10 0x20 0x30 == 'ECAw'
    expect(r.audioBase64).toBe('ECAw');
  });
});

describe('Polish-4: ElevenLabs cost estimates', () => {
  it('scales linearly with script character count', () => {
    expect(estimateElevenLabsCostUsd(0)).toBe(0);
    expect(estimateElevenLabsCostUsd(1000)).toBeCloseTo(0.3);
    expect(estimateElevenLabsCostUsd(500)).toBeCloseTo(0.15);
  });

  it('estimateVoiceoverVariantCostUsd matches estimateElevenLabsCostUsd', () => {
    expect(estimateVoiceoverVariantCostUsd(200)).toBe(estimateElevenLabsCostUsd(200));
  });

  it('has a default voice id', () => {
    expect(getDefaultElevenLabsVoiceId()).toBeTruthy();
  });
});
