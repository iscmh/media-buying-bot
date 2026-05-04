import type { VerifyKeyResult } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * Arcads.
 * Public docs: https://intercom.help/arcads/en/articles/10538922-arcads-ai-api-documentation
 *
 * Integration date: 2025-05-01
 *
 * verifyKey: format-only validation.
 *   The Swagger UI is gated and the help-center article is paywalled, so we
 *   couldn't confirm a clean GET-verify endpoint without a key in hand. The
 *   credential is also a Client ID + Secret pair per their docs, which we
 *   accept either as a single token or joined as `<id>:<secret>`.
 *
 *   Phase 3 will replace this with a real API call inside generateVariants;
 *   if Phase 3 confirms a clean verify endpoint, swap to `method: 'api'`.
 */
const ARCADS_KEY_PATTERN = /^[A-Za-z0-9_:.-]{16,512}$/;

export class ArcadsProvider implements AIProvider {
  readonly name = 'arcads' as const;

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    const trimmed = apiKey.trim();
    if (!ARCADS_KEY_PATTERN.test(trimmed)) {
      return {
        ok: false,
        method: 'format_only',
        reason:
          'Arcads keys are 16+ characters of letters, numbers, hyphens, underscores, dots, or colons.',
      };
    }
    return { ok: true, method: 'format_only' };
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error('ArcadsProvider.generateVariants not implemented (Phase 3)');
  }
}
