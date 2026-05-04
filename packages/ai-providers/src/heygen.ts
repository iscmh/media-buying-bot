import type { VerifyKeyResult } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * HeyGen.
 * API: https://docs.heygen.com (v2 used here for verifyKey)
 *
 * Integration date: 2025-05-01
 *
 * verifyKey: real API call to GET /v2/voices?limit=1 with `X-API-KEY`
 *   header. Picked because it's a small, free GET — no credits deducted,
 *   200 if key is valid, 401/403 if not.
 *
 * generateVariants: stub. Phase 3.
 */
export class HeyGenProvider implements AIProvider {
  readonly name = 'heygen' as const;

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    try {
      const res = await fetch('https://api.heygen.com/v2/voices?limit=1', {
        method: 'GET',
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
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
          reason: 'HeyGen rejected this key. Check it was copied without trailing whitespace.',
        };
      }
      return {
        ok: false,
        method: 'api',
        statusCode: res.status,
        reason: `HeyGen returned HTTP ${res.status}. Try again in a minute.`,
      };
    } catch (err) {
      return {
        ok: false,
        method: 'api',
        reason: `Could not reach HeyGen: ${err instanceof Error ? err.message : 'unknown error'}.`,
      };
    }
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error('HeyGenProvider.generateVariants not implemented (Phase 3)');
  }
}
