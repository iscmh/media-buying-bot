import { z } from 'zod';
import type { AIProviderName } from './types';

/**
 * Per-provider input schema for the BYOK paste form.
 *
 * Notes on credential shapes (researched 2025-05-01):
 *
 *  - HeyGen: single API key, alphanumeric + a few specials, ~30–80 chars.
 *    Verification via real API call to `/v2/voices`.
 *
 *  - Arcads: Client ID + Client Secret model per Arcads docs, but the
 *    docs are gated behind Intercom and we couldn't confirm a clean
 *    GET-verify endpoint. For now we accept either shape (single token OR
 *    `<id>:<secret>` joined) and validate format only. Real verification
 *    happens at first generation in Phase 3.
 *
 *  - Creatify: TWO credentials (X-API-ID + X-API-KEY). Schema only has one
 *    encrypted column, so users paste them joined as `<id>:<key>` and we
 *    split at generation time. Format-only validation here.
 */

// Patterns: hyphen at the END of each char class so it's a literal, not a range.
const ARCADS_KEY_PATTERN = /^[A-Za-z0-9_:.-]{16,512}$/;
const CREATIFY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}:[A-Za-z0-9_-]{16,256}$/;
const HEYGEN_KEY_PATTERN = /^[A-Za-z0-9_=-]{20,256}$/;
// Polish-8: new providers.
const REPLICATE_KEY_PATTERN = /^r8_[A-Za-z0-9]{32,128}$/;
const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,256}$/;
// Polish-21: Hedra API keys are opaque tokens from hedra.com/api-profile.
// Observed shape is 20+ alphanumeric with occasional _-. — we accept a
// wide superset since Hedra hasn't documented an exact charset.
const HEDRA_KEY_PATTERN = /^[A-Za-z0-9_.=-]{20,256}$/;
// Polish-21.0.4 hotfix: ElevenLabs API keys. Observed shape is
// alphanumeric ~48-64 chars, sometimes prefixed with `sk_`. Accept a
// wide superset — ElevenLabs hasn't published a strict format.
const ELEVENLABS_KEY_PATTERN = /^[A-Za-z0-9_.=-]{24,256}$/;
export const AiProviderKeyInputSchema = z
  .object({
    provider: z.enum([
      'arcads',
      'heygen',
      'creatify',
      'replicate',
      'openai',
      'hedra',
      'elevenlabs',
    ]),
    apiKey: z.string().trim().min(1, 'Paste your API key.'),
  })
  .superRefine((value, ctx) => {
    let pattern: RegExp;
    let hint: string;
    switch (value.provider) {
      case 'heygen':
        pattern = HEYGEN_KEY_PATTERN;
        hint = 'HeyGen keys are 20+ chars of letters/numbers (no spaces).';
        break;
      case 'arcads':
        pattern = ARCADS_KEY_PATTERN;
        hint =
          'Arcads keys are 16+ chars; if Arcads gave you a Client ID + Secret, paste them as ID:SECRET.';
        break;
      case 'creatify':
        pattern = CREATIFY_KEY_PATTERN;
        hint = 'Creatify uses two credentials. Paste them joined as API_ID:API_KEY.';
        break;
      case 'replicate':
        pattern = REPLICATE_KEY_PATTERN;
        hint = 'Replicate keys start with r8_ followed by 32+ chars.';
        break;
      case 'openai':
        pattern = OPENAI_KEY_PATTERN;
        hint = 'OpenAI keys start with sk- followed by 20+ chars.';
        break;
      case 'hedra':
        pattern = HEDRA_KEY_PATTERN;
        hint = 'Hedra keys are 20+ chars from hedra.com/api-profile.';
        break;
      case 'elevenlabs':
        pattern = ELEVENLABS_KEY_PATTERN;
        hint = 'ElevenLabs keys are 24+ chars from elevenlabs.io/app/settings/api-keys.';
        break;
    }
    if (!pattern.test(value.apiKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: hint,
        path: ['apiKey'],
      });
    }
  });

export type AiProviderKeyInput = z.infer<typeof AiProviderKeyInputSchema>;

/**
 * Outcome of a verifyKey() call on an AIProvider implementation.
 *
 * `method='api'` means we made a real HTTP call to the provider and got a
 * definitive 200/401. `method='format_only'` means we validated the
 * credential shape but couldn't reach a verify endpoint — real verification
 * is deferred to first generation.
 */
export type VerifyKeyResult =
  | { ok: true; method: 'api' | 'format_only'; statusCode?: number }
  | { ok: false; method: 'api' | 'format_only'; reason: string; statusCode?: number };

/** Canonical display info for each provider, used by the connect UI. */
export const AI_PROVIDER_META: Record<
  AIProviderName,
  {
    label: string;
    description: string;
    pricingUrl: string;
    apiDocsUrl: string;
    verificationMethod: 'api' | 'format_only';
  }
> = {
  arcads: {
    label: 'Arcads',
    description: 'Built for ad creative variants. Recommended primary.',
    pricingUrl: 'https://www.arcads.ai/pricing',
    apiDocsUrl: 'https://intercom.help/arcads/en/articles/10538922-arcads-ai-api-documentation',
    verificationMethod: 'format_only',
  },
  heygen: {
    label: 'HeyGen',
    description: 'Avatar talking head UGC.',
    pricingUrl: 'https://www.heygen.com/pricing',
    apiDocsUrl: 'https://docs.heygen.com',
    verificationMethod: 'api',
  },
  creatify: {
    label: 'Creatify',
    description: 'Cheaper option. Requires two credentials joined as ID:KEY.',
    pricingUrl: 'https://creatify.ai/pricing',
    apiDocsUrl: 'https://docs.creatify.ai',
    verificationMethod: 'format_only',
  },
  replicate: {
    label: 'Replicate',
    description:
      'Kling 2.6 multi-clip video generation with native audio (required for the cinematic pipeline).',
    pricingUrl: 'https://replicate.com/pricing',
    apiDocsUrl: 'https://replicate.com/docs/reference/http',
    verificationMethod: 'api',
  },
  openai: {
    label: 'OpenAI',
    description: 'Whisper audio transcription on uploaded reference videos. Sora 2 (when public).',
    pricingUrl: 'https://openai.com/api/pricing',
    apiDocsUrl: 'https://platform.openai.com/docs/api-reference',
    verificationMethod: 'api',
  },
  hedra: {
    label: 'Hedra',
    description:
      'Character 3 image-to-talking-avatar. Single-call full video, tight lip-sync, no character drift across variants.',
    pricingUrl: 'https://www.hedra.com/pricing',
    apiDocsUrl: 'https://www.hedra.com/docs',
    verificationMethod: 'api',
  },
  elevenlabs: {
    label: 'ElevenLabs',
    description:
      'TTS for the Hedra pipeline. Voice diversity across variants; source-voice cloning path in Polish-22.',
    pricingUrl: 'https://elevenlabs.io/pricing',
    apiDocsUrl: 'https://elevenlabs.io/docs',
    verificationMethod: 'api',
  },
};

/**
 * Polish-8: providers the connections page surfaces as connectable
 * cards. Order matters — drives the on-screen layout. arcads and
 * creatify are intentionally excluded (legacy DB rows remain valid
 * but no new connections via the UI).
 */
// Polish-8: gemini lives in tool_connections (see /connections/tools),
// not ai_provider_connections — the underlying ai_provider enum doesn't
// include 'gemini' because Gemini is a tool provider in the data model.
// The connect cards exposed here are the ones that map to ai_provider_connections rows.
// Polish-21: hedra added as the primary video-gen provider for the
// Character 3 pipeline. Polish-21.0.4 hotfix: elevenlabs added
// second — the Hedra worker needs BOTH keys connected (Hedra for
// video generation + ElevenLabs for TTS audio uploaded as a Hedra
// audio asset). Order matters — hedra then elevenlabs first so
// the connect page surfaces the required pair above the legacy
// heygen/replicate/openai cards.
export const CONNECTABLE_AI_PROVIDERS: AIProviderName[] = [
  'hedra',
  'elevenlabs',
  'heygen',
  'replicate',
  'openai',
];
