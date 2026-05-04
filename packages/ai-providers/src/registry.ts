import type { AIProviderName } from '@mbb/shared';
import { ArcadsProvider } from './arcads.js';
import { CreatifyProvider } from './creatify.js';
import { HeyGenProvider } from './heygen.js';
import type { AIProvider } from './types.js';

const registry = new Map<AIProviderName, AIProvider>([
  ['arcads', new ArcadsProvider()],
  ['heygen', new HeyGenProvider()],
  ['creatify', new CreatifyProvider()],
]);

export function getProvider(name: AIProviderName): AIProvider {
  const p = registry.get(name);
  if (!p) throw new Error(`Unknown AI provider: ${name}`);
  return p;
}

export function registerProvider(provider: AIProvider): void {
  registry.set(provider.name, provider);
}
