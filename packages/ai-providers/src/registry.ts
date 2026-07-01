import type { AIProviderName } from '@mbb/shared';
import { ArcadsProvider } from './arcads';
import { CreatifyProvider } from './creatify';
import { HeyGenProvider } from './heygen';
import { OpenAIProvider } from './openai-provider';
import { ReplicateProvider } from './replicate';
import type { AIProvider } from './types';

const registry = new Map<AIProviderName, AIProvider>([
  ['arcads', new ArcadsProvider()],
  ['heygen', new HeyGenProvider()],
  ['creatify', new CreatifyProvider()],
  // Polish-8: BYOK verify cards for the providers the new pipelines need.
  ['replicate', new ReplicateProvider()],
  ['openai', new OpenAIProvider()],
]);

export function getProvider(name: AIProviderName): AIProvider {
  const p = registry.get(name);
  if (!p) throw new Error(`Unknown AI provider: ${name}`);
  return p;
}

export function registerProvider(provider: AIProvider): void {
  registry.set(provider.name, provider);
}
