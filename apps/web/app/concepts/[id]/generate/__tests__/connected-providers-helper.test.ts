/**
 * Polish-9.3 → Polish-20 Commit 4: pure mapper from
 * ai_provider_connections + tool_connections rows to the
 * ConnectedProviders shape.
 *
 * Post-Commit-4 the shape covers only providers the surviving
 * pipelines still need (heygen / openai / gemini / claude / kie_ai).
 * kling + elevenlabs slots gone with the legacy pipeline deletions.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_QUERY_LIST,
  buildConnectedProviders,
  type AiProviderRow,
} from '../connected-providers-helper';

const NO_TOOLS = new Set<string>();

describe('Polish-20 Commit 4: buildConnectedProviders surviving slots', () => {
  it('heygen row populates tier', () => {
    const rows: AiProviderRow[] = [{ provider: 'heygen', tier: 'premium' }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.heygen.connected).toBe(true);
    expect(r.heygen.tier).toBe('premium');
  });

  it('heygen row with no tier → tier null', () => {
    const rows: AiProviderRow[] = [{ provider: 'heygen', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.heygen.connected).toBe(true);
    expect(r.heygen.tier).toBeNull();
  });

  it('openai mapped from ai row', () => {
    const rows: AiProviderRow[] = [{ provider: 'openai', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.openai.connected).toBe(true);
  });

  it('gemini comes from the tool-connections set, not ai-provider', () => {
    const r = buildConnectedProviders([], new Set(['gemini']));
    expect(r.gemini.connected).toBe(true);
  });

  it('claude + kie_ai slots fill from tool_connections (Polish-12 pattern retained)', () => {
    const r = buildConnectedProviders([], new Set(['claude', 'kie_ai']));
    expect(r.claude.connected).toBe(true);
    expect(r.kie_ai.connected).toBe(true);
    expect(r.gemini.connected).toBe(false);
  });

  it('all-disconnected default shape', () => {
    const r = buildConnectedProviders([], NO_TOOLS);
    expect(r).toEqual({
      heygen: { connected: false, tier: null },
      openai: { connected: false },
      gemini: { connected: false },
      claude: { connected: false },
      kie_ai: { connected: false },
    });
    // Legacy slots removed by Commit 4:
    expect((r as unknown as Record<string, unknown>).kling).toBeUndefined();
    expect((r as unknown as Record<string, unknown>).elevenlabs).toBeUndefined();
  });
});

describe('Polish-20 Commit 4: AI_PROVIDER_QUERY_LIST', () => {
  it('covers only the ai_provider_connections enum values the surviving pipelines consult', () => {
    expect(new Set(AI_PROVIDER_QUERY_LIST)).toEqual(new Set(['heygen', 'openai']));
  });
});
