import type { AIProviderName } from '@mbb/shared';
import { ArcadsProvider } from './arcads';
import { CreatifyProvider } from './creatify';
import { ElevenLabsProvider } from './elevenlabs';
import { HedraProvider } from './hedra';
import { HeyGenProvider } from './heygen';
import { MakeugcProvider } from './makeugc';
import { OpenAIProvider } from './openai-provider';
import { ReplicateProvider } from './replicate';
import { WavespeedProvider } from './wavespeed-provider';
import type { AIProvider } from './types';

const registry = new Map<AIProviderName, AIProvider>([
  ['arcads', new ArcadsProvider()],
  ['heygen', new HeyGenProvider()],
  ['creatify', new CreatifyProvider()],
  // Polish-8: BYOK verify cards for the providers the new pipelines need.
  ['replicate', new ReplicateProvider()],
  ['openai', new OpenAIProvider()],
  // Polish-21: Hedra Character 3 image-to-talking-avatar.
  ['hedra', new HedraProvider()],
  // Polish-21.0.4 hotfix: ElevenLabs TTS BYOK — hands audio bytes
  // to Hedra as an audio_id asset. Replaces Hedra native TTS which
  // was blocked on voice-UUID availability on Creator plans.
  ['elevenlabs', new ElevenLabsProvider()],
  // Polish-23 Commit 1.3 hotfix: register WavespeedAI so
  // getProvider('wavespeed_ai') stops throwing on Save at
  // /connections/ai-provider. verifyKey() delegates to
  // verifyWavespeedKey (401/403 detection). generateVariants()
  // throws — Polish-23 generation dispatches through the worker,
  // not this legacy interface.
  ['wavespeed_ai', new WavespeedProvider()],
  // Polish-25 Commit 1: MakeUGC pay-per-video UGC ad generator.
  // verifyKey delegates to GET /video/avatars?gender=Male (cheap
  // read, no credit deduction; 401/403 = invalid key).
  // generateVariants throws — Polish-25 Commit 2 wires the worker
  // directly on top of the client in makeugc-client.ts.
  ['makeugc', new MakeugcProvider()],
]);

export function getProvider(name: AIProviderName): AIProvider {
  const p = registry.get(name);
  if (!p) throw new Error(`Unknown AI provider: ${name}`);
  return p;
}

export function registerProvider(provider: AIProvider): void {
  registry.set(provider.name, provider);
}
