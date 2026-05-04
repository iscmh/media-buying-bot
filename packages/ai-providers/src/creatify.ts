import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * Creatify (cheaper option).
 * API: https://docs.creatify.ai/
 *
 * Integration date: 2026-05-04
 * API version: TBD
 *
 * Phase 1: stub. Implement in Phase 3.
 */
export class CreatifyProvider implements AIProvider {
  readonly name = 'creatify' as const;

  async verifyKey(_apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    throw new Error('CreatifyProvider.verifyKey not implemented (Phase 3)');
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error('CreatifyProvider.generateVariants not implemented (Phase 3)');
  }
}
