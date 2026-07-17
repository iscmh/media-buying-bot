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
      // Polish-21: hedra slot added for the Character 3 pipeline.
      hedra: { connected: false },
      // Polish-21.0.4 hotfix: elevenlabs slot added — Hedra worker
      // uploads ElevenLabs TTS mp3 as a Hedra audio asset.
      elevenlabs: { connected: false },
      // Polish-23 Commit 3.5: wavespeed_ai + replicate slots added
      // for the Polish-23 Higgsfield-Soul + Veo-Lite pipeline gate.
      wavespeed_ai: { connected: false },
      replicate: { connected: false },
    });
  });

  it('Polish-21: hedra slot populates from ai_provider_connections', () => {
    const rows: AiProviderRow[] = [{ provider: 'hedra', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.hedra.connected).toBe(true);
  });

  it('Polish-21.0.4: elevenlabs slot populates from ai_provider_connections', () => {
    const rows: AiProviderRow[] = [{ provider: 'elevenlabs', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.elevenlabs.connected).toBe(true);
  });
});

describe('Polish-23 Commit 3.5: AI_PROVIDER_QUERY_LIST', () => {
  it('covers surviving legacy slots + wavespeed_ai + replicate + kling for polish23 gate', () => {
    expect(new Set(AI_PROVIDER_QUERY_LIST)).toEqual(
      new Set(['heygen', 'openai', 'hedra', 'elevenlabs', 'wavespeed_ai', 'replicate', 'kling']),
    );
  });
});

describe('Polish-23 Commit 3.5: wavespeed_ai + replicate slots', () => {
  it('wavespeed_ai fills from ai_provider_connections', () => {
    const rows: AiProviderRow[] = [{ provider: 'wavespeed_ai', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.wavespeed_ai.connected).toBe(true);
  });

  it('replicate fills from an explicit "replicate" row', () => {
    const rows: AiProviderRow[] = [{ provider: 'replicate', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.replicate.connected).toBe(true);
  });

  it('replicate ALSO fills from a legacy "kling" row (Polish-9.3 fallback)', () => {
    const rows: AiProviderRow[] = [{ provider: 'kling', tier: null }];
    const r = buildConnectedProviders(rows, NO_TOOLS);
    expect(r.replicate.connected).toBe(true);
  });
});
