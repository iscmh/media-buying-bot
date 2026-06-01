import type { VerifyKeyResult } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * Polish-8: OpenAI verify card. Used by:
 *   - Whisper audio transcription on uploaded reference videos
 *     (transcribeAudio in vision-detection.ts)
 *   - Sora 2 direct path (when/if OpenAI ships it publicly)
 *
 * Verify endpoint: GET /v1/models — cheapest read that authenticates.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai' as const;

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        return { ok: true, method: 'api', statusCode: res.status };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          method: 'api',
          statusCode: res.status,
          reason: 'OpenAI rejected this key. Generate one at platform.openai.com/api-keys.',
        };
      }
      return {
        ok: false,
        method: 'api',
        statusCode: res.status,
        reason: `OpenAI returned HTTP ${res.status}. Try again in a minute.`,
      };
    } catch (err) {
      return {
        ok: false,
        method: 'api',
        reason: `Could not reach OpenAI: ${err instanceof Error ? err.message : 'unknown error'}.`,
      };
    }
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error(
      'OpenAIProvider.generateVariants not used — Whisper + Sora route through dedicated clients.',
    );
  }
}
