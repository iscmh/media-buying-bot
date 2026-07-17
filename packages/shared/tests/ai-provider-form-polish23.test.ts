import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_META,
  AiProviderKeyInputSchema,
  CONNECTABLE_AI_PROVIDERS,
} from '../src/ai-provider-form';

describe('Polish-23 Commit 1: wavespeed_ai BYOK schema + connect card', () => {
  it('accepts a valid wsk_ key (base62 tail ≥ 24 chars)', () => {
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'wsk_' + 'A'.repeat(24),
    });
    expect(r.success).toBe(true);
  });

  it('rejects keys without the wsk_ prefix', () => {
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'sk_' + 'B'.repeat(24),
    });
    expect(r.success).toBe(false);
  });

  it('rejects keys with a too-short tail (<24 chars)', () => {
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'wsk_short',
    });
    expect(r.success).toBe(false);
  });

  it('rejects keys with special characters in the tail (base62 only)', () => {
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'wsk_' + 'A'.repeat(23) + '!',
    });
    expect(r.success).toBe(false);
  });

  it('AI_PROVIDER_META has a wavespeed_ai entry with pricing + docs URLs', () => {
    expect(AI_PROVIDER_META['wavespeed_ai']).toBeDefined();
    expect(AI_PROVIDER_META['wavespeed_ai'].label).toBe('WaveSpeedAI');
    expect(AI_PROVIDER_META['wavespeed_ai'].pricingUrl).toContain('wavespeed.ai');
    expect(AI_PROVIDER_META['wavespeed_ai'].apiDocsUrl).toContain('wavespeed.ai');
    // Verification is via a real API round-trip (documented in
    // wavespeed.ts verifyWavespeedKey — 401/403 detection).
    expect(AI_PROVIDER_META['wavespeed_ai'].verificationMethod).toBe('api');
  });

  it('CONNECTABLE_AI_PROVIDERS surfaces wavespeed_ai on the connections page', () => {
    // The connect grid iterates this list; excluding wavespeed_ai
    // means the operator has no way to paste the key in the UI.
    expect(CONNECTABLE_AI_PROVIDERS).toContain('wavespeed_ai');
  });

  it("regression pin: the existing Polish-21 providers didn't get accidentally removed", () => {
    // Polish-23 Commit 5 will delete hedra + elevenlabs when the
    // pipeline pivot completes. Until then they stay so live
    // Polish-21 users don't get their connect card yanked.
    for (const p of ['hedra', 'elevenlabs', 'heygen', 'replicate', 'openai'] as const) {
      expect(CONNECTABLE_AI_PROVIDERS).toContain(p);
    }
  });
});
