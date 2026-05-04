import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * Arcads (recommended primary).
 * API: https://www.arcads.ai/  — public API docs as of integration date.
 *
 * Integration date: 2026-05-04
 * API version: TBD (no version pinning available; docs subject to change).
 *
 * Phase 1: stub. Implement in Phase 3.
 */
export class ArcadsProvider implements AIProvider {
  readonly name = 'arcads' as const;

  async verifyKey(_apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    throw new Error('ArcadsProvider.verifyKey not implemented (Phase 3)');
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error('ArcadsProvider.generateVariants not implemented (Phase 3)');
  }
}
