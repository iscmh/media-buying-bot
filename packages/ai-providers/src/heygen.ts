import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * HeyGen (most established UGC AI provider).
 * API: https://docs.heygen.com/ (v2 as of integration date)
 *
 * Integration date: 2026-05-04
 * API version: v2
 *
 * Phase 1: stub. Implement in Phase 3.
 */
export class HeyGenProvider implements AIProvider {
  readonly name = 'heygen' as const;

  async verifyKey(_apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    throw new Error('HeyGenProvider.verifyKey not implemented (Phase 3)');
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error('HeyGenProvider.generateVariants not implemented (Phase 3)');
  }
}
