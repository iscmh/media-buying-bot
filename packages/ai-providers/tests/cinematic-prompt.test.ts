/**
 * Polish-4: buildCinematicPromptFromScript — Claude translates an ad
 * script into a Kling cinematic prompt. Verifies the system-prompt /
 * user-message shape + handles empty input + strips wrapping quotes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import { buildCinematicPromptFromScript } from '../src/claude-client';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function mockClaudeReply(text: string, opts: { status?: number } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      status: opts.status ?? 200,
      text: async () =>
        JSON.stringify({
          content: [{ type: 'text', text }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    } as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

describe('Polish-4: buildCinematicPromptFromScript', () => {
  it('returns the cinematic prompt verbatim from Claude', async () => {
    mockClaudeReply(
      'A vertical 9:16 dawn sequence — wide drone over a foggy beach, push-in to a single footprint in sand, cut to soft sunlight breaking through clouds.',
    );
    const r = await buildCinematicPromptFromScript({
      userId: 'u',
      apiKey: 'k',
      script: 'I tried this for 30 days and everything changed.',
    });
    expect(r.ok).toBe(true);
    expect(r.prompt).toMatch(/vertical 9:16/);
    expect(r.prompt).toMatch(/footprint/);
  });

  it('strips wrapping double quotes if Claude returns quoted prose', async () => {
    mockClaudeReply('"A clean cinematic prompt."');
    const r = await buildCinematicPromptFromScript({
      userId: 'u',
      apiKey: 'k',
      script: 'short.',
    });
    expect(r.ok).toBe(true);
    expect(r.prompt).toBe('A clean cinematic prompt.');
  });

  it('rejects empty script without calling Claude', async () => {
    const calls = mockClaudeReply('should not be called');
    const r = await buildCinematicPromptFromScript({
      userId: 'u',
      apiKey: 'k',
      script: '   ',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/empty/i);
    expect(calls).toHaveLength(0);
  });

  it('passes the script as the user message + sends a directive system prompt', async () => {
    const calls = mockClaudeReply('Some prompt');
    await buildCinematicPromptFromScript({
      userId: 'u',
      apiKey: 'k',
      script: 'Morning routine that changed my life.',
    });
    const init = calls[0]!.init!;
    const body = JSON.parse(init.body as string);
    expect(body.system).toMatch(/cinematic|Kling/i);
    expect(body.messages[0].content).toMatch(/Morning routine/);
  });

  it('surfaces Claude error as ok=false without throwing', async () => {
    mockClaudeReply('', { status: 401 });
    const r = await buildCinematicPromptFromScript({
      userId: 'u',
      apiKey: 'bad',
      script: 'whatever',
    });
    expect(r.ok).toBe(false);
    expect(r.prompt).toBeUndefined();
  });
});
