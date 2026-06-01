import type { VerifyKeyResult } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';

/**
 * Polish-8: ElevenLabs verify card. Optional / legacy provider —
 * Polish-4's cinematic voiceover pipeline used it for TTS, but
 * Polish-6 replaced that pipeline with Kling 3.0 native lipsync.
 * Real TTS code lives in elevenlabs.ts.
 *
 * Verify endpoint: GET /v1/user — returns plan info if the key works.
 */
export class ElevenLabsProvider implements AIProvider {
  readonly name = 'elevenlabs' as const;

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        method: 'GET',
        headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
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
            'ElevenLabs rejected this key. Find a fresh one at elevenlabs.io profile settings.',
        };
      }
      return {
        ok: false,
        method: 'api',
        statusCode: res.status,
        reason: `ElevenLabs returned HTTP ${res.status}. Try again in a minute.`,
      };
    } catch (err) {
      return {
        ok: false,
        method: 'api',
        reason: `Could not reach ElevenLabs: ${err instanceof Error ? err.message : 'unknown error'}.`,
      };
    }
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error(
      'ElevenLabsProvider.generateVariants not used — TTS routes through elevenlabs.ts.',
    );
  }
}
