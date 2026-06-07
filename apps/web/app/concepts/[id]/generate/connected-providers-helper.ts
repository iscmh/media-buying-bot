/**
 * Polish-9.3: pure mapper from raw connection rows to the
 * ConnectedProviders shape the form picker consumes.
 *
 * Extracted so vitest can cover the kling↔replicate mapping without
 * mocking Supabase + Drizzle. The Polish-8 UI ships a "Replicate"
 * card (correct — Replicate hosts Kling 3.0), but the Polish-6
 * backend assumed a 'kling' provider. This helper treats either DB
 * row as filling the kling capability slot.
 */

export interface ConnectedProviders {
  heygen: { connected: boolean; tier: 'free' | 'pro' | 'premium' | null };
  kling: { connected: boolean };
  elevenlabs: { connected: boolean };
  openai: { connected: boolean };
  gemini: { connected: boolean };
}

export interface AiProviderRow {
  provider: string;
  tier: string | null;
}

/**
 * Polish-9.3: kling capability fills from EITHER a 'kling' DB row
 * (legacy Polish-4 path) OR a 'replicate' DB row (Polish-8 UI card).
 * Replicate is the API endpoint for Kling in our architecture; the
 * abstraction the form picker uses is 'kling'.
 */
export function buildConnectedProviders(
  aiRows: AiProviderRow[],
  toolProviders: ReadonlySet<string>,
): ConnectedProviders {
  const byAi = new Map<string, AiProviderRow>(aiRows.map((r) => [r.provider, r]));
  const klingRow = byAi.get('kling') ?? byAi.get('replicate');
  return {
    heygen: {
      connected: byAi.has('heygen'),
      tier: (byAi.get('heygen')?.tier as 'free' | 'pro' | 'premium' | null | undefined) ?? null,
    },
    kling: { connected: !!klingRow },
    elevenlabs: { connected: byAi.has('elevenlabs') },
    openai: { connected: byAi.has('openai') },
    gemini: { connected: toolProviders.has('gemini') },
  };
}

/**
 * Polish-9.3: the ai_provider DB enum values the loader queries for.
 * Includes 'replicate' so the Polish-8 UI card's row gets picked up.
 */
export const AI_PROVIDER_QUERY_LIST = [
  'heygen',
  'kling',
  'replicate',
  'elevenlabs',
  'openai',
] as const;
