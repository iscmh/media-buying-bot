import type { VerifyKeyResult } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * Polish-8: Replicate verify card. Real generation lives in the
 * existing kling.ts client (which posts to /v1/models/.../predictions);
 * this class only exists so the BYOK connect form can run a live
 * verify against /v1/account.
 */
export class ReplicateProvider implements AIProvider {
  readonly name = 'replicate' as const;

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    try {
      const res = await fetch('https://api.replicate.com/v1/account', {
        method: 'GET',
        headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
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
          reason:
            'Replicate rejected this token. Generate a new one at replicate.com/account/api-tokens.',
        };
      }
      return {
        ok: false,
        method: 'api',
        statusCode: res.status,
        reason: `Replicate returned HTTP ${res.status}. Try again in a minute.`,
      };
    } catch (err) {
      return {
        ok: false,
        method: 'api',
        reason: `Could not reach Replicate: ${err instanceof Error ? err.message : 'unknown error'}.`,
      };
    }
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error(
      'ReplicateProvider.generateVariants not used — generation routes through @mbb/jobs Kling worker.',
    );
  }
}
