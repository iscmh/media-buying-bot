/**
 * Polish-9.3: pure mapper from ai_provider_connections rows to the
 * ConnectedProviders shape. The critical invariant is the kling↔replicate
 * mapping — the Polish-8 UI ships a "Replicate" card, the Polish-6
 * backend expects a 'kling' capability flag. Either DB row fills it.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_QUERY_LIST,
  buildConnectedProviders,
  type AiProviderRow,
} from '../connected-providers-helper';

const NO_TOOLS = new Set<string>();

describe('Polish-9.3: buildConnectedProviders kling↔replicate mapping', () => {
  it('only kling row → kling.connected=true (legacy path)', () => {
    const rows: AiProviderRow[] = [{ provider: 'kling', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.kling.connected).toBe(true);
  });

  it('only replicate row → kling.connected=true (Polish-8 UI card)', () => {
    const rows: AiProviderRow[] = [{ provider: 'replicate', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.kling.connected).toBe(true);
  });

  it('both rows present → kling.connected=true, no crash', () => {
    const rows: AiProviderRow[] = [
      { provider: 'kling', tier: null },
      { provider: 'replicate', tier: null },
    ];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.kling.connected).toBe(true);
  });

  it('neither row → kling.connected=false', () => {
    const r = buildConnectedProviders([], NO_TOOLS);
    expect(r.kling.connected).toBe(false);
  });

  it('arcads/creatify alone does NOT fill the kling slot', () => {
    const rows: AiProviderRow[] = [
      { provider: 'arcads', tier: null },
      { provider: 'creatify', tier: null },
    ];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.kling.connected).toBe(false);
  });
});

describe('Polish-9.3: other provider slots unaffected', () => {
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

  it('elevenlabs / openai mapped from ai rows', () => {
    const rows: AiProviderRow[] = [
      { provider: 'elevenlabs', tier: null },
      { provider: 'openai', tier: null },
    ];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.elevenlabs.connected).toBe(true);
    expect(r.openai.connected).toBe(true);
  });

  it('gemini comes from the tool-connections set, not ai-provider', () => {
    const r = buildConnectedProviders([], new Set(['gemini']));
    expect(r.gemini.connected).toBe(true);
  });

  it('all-disconnected default', () => {
    const r = buildConnectedProviders([], NO_TOOLS);
    expect(r).toEqual({
      heygen: { connected: false, tier: null },
      kling: { connected: false },
      elevenlabs: { connected: false },
      openai: { connected: false },
      gemini: { connected: false },
    });
  });
});

describe('Polish-9.3: AI_PROVIDER_QUERY_LIST', () => {
  it('includes both kling and replicate so the loader picks up either row', () => {
    expect(AI_PROVIDER_QUERY_LIST).toContain('kling');
    expect(AI_PROVIDER_QUERY_LIST).toContain('replicate');
  });

  it('covers every provider the form picker cares about', () => {
    for (const p of ['heygen', 'kling', 'replicate', 'elevenlabs', 'openai']) {
      expect(AI_PROVIDER_QUERY_LIST).toContain(p);
    }
  });
});
