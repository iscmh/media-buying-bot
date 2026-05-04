import type { VerifyKeyResult } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * Creatify.
 * Docs: https://docs.creatify.ai/api-reference/authentication
 *
 * Integration date: 2025-05-01
 *
 * Auth model: TWO credentials per Creatify docs — `X-API-ID` and
 * `X-API-KEY`. Our `ai_provider_connections.api_key_encrypted` column
 * stores ONE string. Operators paste the credentials joined as
 * `<API_ID>:<API_KEY>`; we'll split at generation time in Phase 3.
 *
 * verifyKey: format-only validation. The docs site blocks our user-agent
 * (HTTP 403) so we couldn't pin a verify endpoint. Phase 3 will hit
 * `/api/personas/` or similar inside generateVariants; if it confirms a
 * clean verify endpoint, swap this to `method: 'api'`.
 */
const CREATIFY_COMBINED_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}:[A-Za-z0-9_-]{16,256}$/;

export class CreatifyProvider implements AIProvider {
  readonly name = 'creatify' as const;

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    const trimmed = apiKey.trim();
    if (!CREATIFY_COMBINED_KEY_PATTERN.test(trimmed)) {
      return {
        ok: false,
        method: 'format_only',
        reason:
          'Creatify uses two credentials. Paste them as API_ID:API_KEY (8+ chars before the colon, 16+ after).',
      };
    }
    return { ok: true, method: 'format_only' };
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error('CreatifyProvider.generateVariants not implemented (Phase 3)');
  }
}
