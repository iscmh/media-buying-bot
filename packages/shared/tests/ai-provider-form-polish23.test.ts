import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_META,
  AiProviderKeyInputSchema,
  CONNECTABLE_AI_PROVIDERS,
} from '../src/ai-provider-form';

describe('Polish-23 Commit 1.2: wavespeed_ai BYOK schema (permissive) + connect card', () => {
  it('accepts a real-shape wsk_live_ key (Stripe-pattern env sub-segment + base62 tail)', () => {
    // Real key form observed in the operator's WaveSpeedAI
    // dashboard, e.g. `wsk_live_9BLa6awbBLXSM...`. The Commit 1 /
    // Commit 1.1 regexes rejected this because they refused the
    // `_live_` sub-segment.
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'wsk_live_9BLa6awbBLXSMabcdefghij',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a wsk_test_ (sandbox / staging) key with the same shape', () => {
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'wsk_test_' + 'A'.repeat(24),
    });
    expect(r.success).toBe(true);
  });

  it('accepts a legacy no-env-segment wsk_ key (permissive envelope tolerates it)', () => {
    // Commit 1.2 deliberately drops the strict env-segment
    // requirement. If WaveSpeedAI ever emits a key without
    // `_live_` / `_test_`, we still accept it and let the real
    // API round-trip in verifyWavespeedKey be the source of truth.
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'wsk_' + 'A'.repeat(24),
    });
    expect(r.success).toBe(true);
  });

  it('rejects keys without the wsk_ prefix', () => {
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'sk_live_' + 'B'.repeat(24),
    });
    expect(r.success).toBe(false);
  });

  it('rejects keys with a too-short tail (<20 chars after wsk_)', () => {
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'wsk_short',
    });
    expect(r.success).toBe(false);
  });

  it('rejects keys with a too-long tail (>150 chars after wsk_)', () => {
    // Upper bound guards against a paste that grabbed extra
    // surrounding text (e.g. the entire dashboard row). 150 chars
    // is generous — real WaveSpeedAI keys are ~40 chars.
    const r = AiProviderKeyInputSchema.safeParse({
      provider: 'wavespeed_ai',
      apiKey: 'wsk_' + 'A'.repeat(151),
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
