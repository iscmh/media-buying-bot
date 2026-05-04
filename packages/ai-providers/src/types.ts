import type { AIProviderName, AspectRatio, ConceptInput } from '@mbb/shared';

export interface GenerateInput {
  apiKey: string; // user's BYOK key, decrypted by caller
  concepts: ConceptInput[];
  count: number; // requested variant count, e.g. 30-40
  aspectRatios: AspectRatio[];
}

export interface GeneratedCreative {
  fileUrl: string;
  aspectRatio: AspectRatio;
  hookVariantIndex?: number;
  bodyVariantIndex?: number;
  ctaVariantIndex?: number;
  providerJobId?: string; // for status polling if the provider is async
}

/**
 * Common contract every AI UGC provider implements. New providers slot in
 * by implementing this and registering in `registry.ts`.
 *
 * Bot logic depends on this interface only — never on a concrete provider —
 * so users can switch providers in settings without touching downstream code.
 */
export interface AIProvider {
  readonly name: AIProviderName;

  /** Lightweight call to confirm the user's API key is valid. */
  verifyKey(apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }>;

  /** Kick off a generation job. May be sync or async per provider. */
  generateVariants(input: GenerateInput): Promise<GeneratedCreative[]>;
}
