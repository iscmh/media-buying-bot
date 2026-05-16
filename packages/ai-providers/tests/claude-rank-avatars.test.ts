/**
 * Phase 3g: claudeRankAvatars — wraps callClaude with a casting-director
 * system prompt, validates the JSON array output, drops hallucinated IDs.
 *
 * Tests use the same fetch-mock pattern as chokepoint.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import { claudeRankAvatars } from '../src/claude-client';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function mockClaudeReply(text: string, opts: { status?: number } = {}) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    status: opts.status ?? 200,
    text: async () =>
      JSON.stringify({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
  } as Response) as typeof globalThis.fetch;
}

const AVATARS = [
  { id: 'a1', name: 'Daisy', gender: 'female' },
  { id: 'a2', name: 'Tom', gender: 'male' },
  { id: 'a3', name: 'Sarah', gender: 'female' },
];

describe('claudeRankAvatars', () => {
  it('returns ranked ids in Claude order on a valid response', async () => {
    mockClaudeReply('["a3","a1","a2"]');
    const r = await claudeRankAvatars({
      userId: 'u',
      apiKey: 'k',
      personaDescription: 'young woman, fitness vibe',
      avatars: AVATARS,
    });
    expect(r.ok).toBe(true);
    expect(r.rankedIds).toEqual(['a3', 'a1', 'a2']);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('strips ```json fences automatically (defense in depth)', async () => {
    mockClaudeReply('```json\n["a2","a1"]\n```');
    const r = await claudeRankAvatars({
      userId: 'u',
      apiKey: 'k',
      personaDescription: 'whatever',
      avatars: AVATARS,
    });
    expect(r.ok).toBe(true);
    expect(r.rankedIds).toEqual(['a2', 'a1']);
  });

  it('drops hallucinated avatar ids not in the input', async () => {
    mockClaudeReply('["a1","HALLUCINATED","a2","ALSO_FAKE"]');
    const r = await claudeRankAvatars({
      userId: 'u',
      apiKey: 'k',
      personaDescription: 'x',
      avatars: AVATARS,
    });
    expect(r.ok).toBe(true);
    expect(r.rankedIds).toEqual(['a1', 'a2']); // hallucinations filtered
  });

  it('de-duplicates if Claude returns the same id twice', async () => {
    mockClaudeReply('["a1","a1","a2","a1"]');
    const r = await claudeRankAvatars({
      userId: 'u',
      apiKey: 'k',
      personaDescription: 'x',
      avatars: AVATARS,
    });
    expect(r.ok).toBe(true);
    expect(r.rankedIds).toEqual(['a1', 'a2']);
  });

  it('errors when Claude returns non-JSON (e.g. apology prose)', async () => {
    mockClaudeReply("I'm sorry, I can't rank these without more information.");
    const r = await claudeRankAvatars({
      userId: 'u',
      apiKey: 'k',
      personaDescription: 'x',
      avatars: AVATARS,
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/JSON array/i);
  });

  it('errors when Claude returns a JSON object instead of array', async () => {
    mockClaudeReply('{"ranking":["a1","a2"]}');
    const r = await claudeRankAvatars({
      userId: 'u',
      apiKey: 'k',
      personaDescription: 'x',
      avatars: AVATARS,
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/JSON array/i);
  });

  it('errors fast when given an empty avatar list (no API call)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const r = await claudeRankAvatars({
      userId: 'u',
      apiKey: 'k',
      personaDescription: 'x',
      avatars: [],
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/no avatars/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces upstream HTTP errors from Claude', async () => {
    mockClaudeReply(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
    const r = await claudeRankAvatars({
      userId: 'u',
      apiKey: 'k',
      personaDescription: 'x',
      avatars: AVATARS,
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/bad key|HTTP 401/);
  });
});
