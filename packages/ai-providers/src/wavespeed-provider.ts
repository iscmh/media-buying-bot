import type { AIProviderName } from '@mbb/shared';
import type { AIProvider, GenerateInput, GeneratedCreative } from './types';
import { verifyWavespeedKey } from './wavespeed';

/**
 * Polish-23 Commit 1.3: fills the runtime-registry hole that made
 * `getProvider('wavespeed_ai')` throw `Unknown AI provider` on
 * every save at /connections/ai-provider.
 *
 * verifyKey() delegates to the raw-client 401/403 probe in
 * wavespeed.ts — same detection logic the CI tests already cover.
 *
 * generateVariants() intentionally throws. Polish-23 dispatches
 * generation through the descriptor-driven worker (Commit 3, event
 * `generation/polish23-veo-lite.requested`) instead of the legacy
 * per-provider `generateVariants` interface, because the flow
 * needs a shared Higgsfield Soul reference threaded across ALL
 * clips in a batch — not the one-shot per-provider generation the
 * old interface assumed. Calling this method is a routing bug.
 */
export class WavespeedProvider implements AIProvider {
  readonly name: AIProviderName = 'wavespeed_ai';

  async verifyKey(apiKey: string) {
    return verifyWavespeedKey(apiKey);
  }

  async generateVariants(_input: GenerateInput): Promise<GeneratedCreative[]> {
    throw new Error(
      'Not implemented via legacy AIProvider.generateVariants — Polish-23 pipeline ' +
        'dispatches through the worker in Commit 3 (generation/polish23-veo-lite.requested), ' +
        'not this interface.',
    );
  }
}
