import type { AIProviderName, VerifyKeyResult } from '@mbb/shared';
import { verifyHedraKey } from './hedra-video';
import type { AIProvider } from './types';

/**
 * Polish-21: BYOK verify-key card for Hedra. Mirrors HeyGenProvider —
 * `generateVariants` isn't used for Hedra (the video-variant worker
 * calls submitHedraGeneration directly). Present only so the connect
 * UI's registry lookup finds a name → verify implementation.
 */
export class HedraProvider implements AIProvider {
  readonly name: AIProviderName = 'hedra';

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    return verifyHedraKey(apiKey);
  }

  async generateVariants(): Promise<never> {
    throw new Error(
      'HedraProvider.generateVariants is not used — the Polish-21 video-variant worker ' +
        'calls submitHedraGeneration directly. If you need batch generation, wire the ' +
        'flow through generate-video-variant.ts.',
    );
  }
}
