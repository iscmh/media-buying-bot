import type { VerifyKeyResult } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * Polish-25 Commit 1: MakeUGC provider adapter.
 *
 * MakeUGC (app.makeugc.ai) — pay-per-video UGC ad generator that
 * replaces the Polish-24 HeyGen pivot after avatar-quality rejection.
 * $99/mo API Starter = 2,000 credits/mo = $0.0495/video (20-50x
 * cheaper than HeyGen/Veo).
 *
 * verifyKey: GET /video/avatars?gender=Male (cheap read, no credit
 *   deduction). 200 = valid key; 401/403 = invalid; other statuses
 *   surface as retry-later. Auth via X-Api-Key header (NOT
 *   Authorization: Bearer).
 *
 * generateVariants: stub. Polish-25 Commit 2 will wire the Inngest
 *   worker on top of the client in makeugc-client.ts; this AIProvider
 *   adapter is retained for legacy compatibility with the BYOK
 *   verify flow only.
 */
export class MakeugcProvider implements AIProvider {
  readonly name = 'makeugc' as const;

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    try {
      const res = await fetch('https://app.makeugc.ai/api/platform/video/avatars?gender=Male', {
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
          reason:
            'MakeUGC rejected this key. Copy a fresh key from ' +
            'app.makeugc.ai (Settings → API), no trailing whitespace.',
        };
      }
      return {
        ok: false,
        method: 'api',
        statusCode: res.status,
        reason: `MakeUGC returned HTTP ${res.status}. Try again in a minute.`,
      };
    } catch (err) {
      return {
        ok: false,
        method: 'api',
        reason: `Could not reach MakeUGC: ${err instanceof Error ? err.message : 'unknown error'}.`,
      };
    }
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error(
      'MakeugcProvider.generateVariants not implemented — Polish-25 Commit 2 wires the ' +
        'Inngest worker directly on top of submitMakeugcVideo + checkMakeugcVideoStatus ' +
        'from makeugc-client.ts.',
    );
  }
}
