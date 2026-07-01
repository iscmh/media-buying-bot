/**
 * Polish-9.3 → Polish-20 Commit 4: pure mapper from raw connection
 * rows to the ConnectedProviders shape the form picker consumes.
 *
 * Post-Commit-4 the shape is trimmed to the providers the surviving
 * pipelines still need:
 *   - heygen (HeyGen avatar pipeline)
 *   - openai (Sora 2)
 *   - gemini + claude + kie_ai (video-variant worker + static image)
 *
 * elevenlabs deleted with the ElevenLabs client. `kling` deleted with
 * the four Kling-family pipelines — the kie.ai video worker uses the
 * `kie_ai` credential instead. The `kling` label survives inside
 * chokepoint.ProviderName because Replicate's shared helpers
 * (concat / lipsync / audio-trim / frame-extract) still tag their
 * BYOK audit rows with it, but that's a chokepoint-only concern —
 * the form no longer surfaces a Kling capability.
 */

export interface ConnectedProviders {
  heygen: { connected: boolean; tier: 'free' | 'pro' | 'premium' | null };
  openai: { connected: boolean };
  gemini: { connected: boolean };
  // Polish-12: Claude + kie.ai in tool_connections (not
  // ai_provider_connections) — toolProviders is the auth source.
  claude: { connected: boolean };
  kie_ai: { connected: boolean };
}

export interface AiProviderRow {
  provider: string;
  tier: string | null;
}

export function buildConnectedProviders(
  aiRows: AiProviderRow[],
  toolProviders: ReadonlySet<string>,
): ConnectedProviders {
  const byAi = new Map<string, AiProviderRow>(aiRows.map((r) => [r.provider, r]));
  return {
    heygen: {
      connected: byAi.has('heygen'),
      tier: (byAi.get('heygen')?.tier as 'free' | 'pro' | 'premium' | null | undefined) ?? null,
    },
    openai: { connected: byAi.has('openai') },
    gemini: { connected: toolProviders.has('gemini') },
    claude: { connected: toolProviders.has('claude') },
    kie_ai: { connected: toolProviders.has('kie_ai') },
  };
}

/**
 * ai_provider DB enum values the loader queries for. Only the
 * providers the surviving pipelines still consult are listed.
 */
export const AI_PROVIDER_QUERY_LIST = ['heygen', 'openai'] as const;
