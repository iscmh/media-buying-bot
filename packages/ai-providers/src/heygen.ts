import type { VerifyKeyResult } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * HeyGen.
 * API: https://docs.heygen.com
 *
 * Integration date: 2025-05-01
 * Polish-24 Commit 1 (2026-07-20): verifyKey swapped to
 *   GET /v2/user/remaining_quota — cheaper + returns billing info
 *   (remaining_quota credits ≈ $0.01/credit) that the connect UI can
 *   surface. Older /v2/voices?limit=1 approach worked but wasted a
 *   full voice-catalog fetch just to check auth. Auth header remains
 *   `X-Api-Key` (per HeyGen docs — NOT `Authorization: Bearer`).
 *
 * generateVariants: stub. Polish-24 Commit 2 will wire the Polish-24
 *   Inngest worker on top of the client in heygen-client.ts; this
 *   AIProvider adapter is retained for legacy compatibility with the
 *   BYOK verify flow only.
 */
export class HeyGenProvider implements AIProvider {
  readonly name = 'heygen' as const;

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    try {
      const res = await fetch('https://api.heygen.com/v2/user/remaining_quota', {
        method: 'GET',
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
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
    throw new Error(
      'HeyGenProvider.generateVariants not implemented — Polish-24 uses the ' +
        'submitHeygenPolish24VideoWithChurnRetry client directly from the worker.',
    );
  }
}
