/**
 * Polish-23 Commit 1.3 hotfix regression pin.
 *
 * Commit 1 added `wavespeed_ai` to the AIProviderName union,
 * AI_PROVIDER_META, and CONNECTABLE_AI_PROVIDERS — but forgot to
 * register a concrete AIProvider instance in
 * packages/ai-providers/src/registry.ts. The result: any Save on
 * /connections/ai-provider threw `Unknown AI provider:
 * wavespeed_ai` in Vercel prod.
 *
 * This test closes the drift class by asserting that every entry
 * in CONNECTABLE_AI_PROVIDERS resolves to a real provider through
 * getProvider() — no throws, no undefineds. Adding a new provider
 * to the enum without registering it in the runtime map fails CI
 * before Vercel ever sees it.
 */
import { describe, expect, it } from 'vitest';
import { CONNECTABLE_AI_PROVIDERS } from '@mbb/shared';
import { getProvider } from '../src/registry';

describe('Polish-23 Commit 1.3: provider registry covers every CONNECTABLE_AI_PROVIDERS entry', () => {
  it('getProvider() returns a real AIProvider instance for every connectable provider', () => {
    for (const name of CONNECTABLE_AI_PROVIDERS) {
      // Explicit try/catch so a failure names which provider drifted
      // instead of surfacing a generic "Unknown AI provider" throw
      // — future maintainers see the offender in one glance.
      let provider;
      try {
        provider = getProvider(name);
      } catch (err) {
        throw new Error(
          `CONNECTABLE_AI_PROVIDERS lists "${name}" but registry.ts has no ` +
            `matching entry. Fix: add \`['${name}', new SomeProvider()]\` to ` +
            `the registry Map. Underlying error: ${(err as Error).message}`,
        );
      }
      expect(provider).toBeDefined();
      expect(provider.name).toBe(name);
      expect(typeof provider.verifyKey).toBe('function');
      expect(typeof provider.generateVariants).toBe('function');
    }
  });

  it('wavespeed_ai specifically resolves — Commit 1.3 regression anchor', () => {
    // Named test in addition to the loop above so the failure line
    // number stays stable across future CONNECTABLE_AI_PROVIDERS
    // reorderings.
    const provider = getProvider('wavespeed_ai');
    expect(provider.name).toBe('wavespeed_ai');
    expect(typeof provider.verifyKey).toBe('function');
  });
});
