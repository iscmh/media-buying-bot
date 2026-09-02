/**
 * Polish-29.0.0 Commit 109: single source of truth for credit-based
 * pricing. Both the frontend UI (savings badges, cost previews,
 * dashboard rollup) and the backend billing code (reserve on job
 * start, spend on job success, refund on fail) import from here.
 *
 * Editing credit costs / retail comparisons in one file changes
 * every consumer at once — a critical property for a pricing
 * surface that drives revenue.
 *
 * ## Model
 *
 * A "credit" is a fixed-price unit the user buys. Cost is uniform
 * ($0.02 per credit) regardless of what the credit is spent on. What
 * varies per model is how MANY credits an action burns.
 *
 * Retail comparison prices are current as of Polish-29.0.0 based on
 * each provider's public pricing page. When Meta/Anthropic/OpenAI/etc.
 * change their pricing, bump the numbers here in one place. The
 * "You save X%" badges throughout the app update automatically.
 *
 * ## Provider mode
 *
 * Every model is either:
 *   - CREDITS  — routed through our optimized provider stack
 *                (useapi.net for Seedance / Kling / Nano Banana /
 *                Runway / Veo / PixVerse / MiniMax). User pays credits.
 *                We keep the margin.
 *   - BYOK     — user brings their own key. No credit charge.
 *                We take zero cut. Used for HeyGen / official OpenAI /
 *                official Claude / ElevenLabs — providers where we
 *                have no cost advantage and where the user comparing
 *                to our markup would call us out.
 *
 * A future "MANAGED_BYOK" mode could sit between the two — we hold an
 * enterprise account for a specific provider (e.g. HeyGen enterprise
 * commit) and charge users credits at a 10-20% markup. Not needed at
 * launch.
 */

/** USD price of one credit. */
export const CREDIT_UNIT_USD = 0.02;

/** Credits included in the base PRO subscription every month. */
export const PRO_INCLUDED_CREDITS = 2500;

/** Free trial credits granted on signup (before any payment). */
export const SIGNUP_FREE_TRIAL_CREDITS = 100;

export type ProviderMode = 'credits' | 'byok';

/**
 * Family of pipelines the app supports. A single credit-costed model
 * can be used by multiple pipelines — e.g. Nano Banana powers the
 * static-ad pipeline AND the UGC-clone frame extraction step.
 */
export type PipelineFamily = 'ugc' | 'static' | 'variations' | 'clone';

export interface CreditModel {
  /** Stable id used in DB rows + logs + code lookups. Never rename. */
  id: string;
  /** Human-facing label rendered in UI. */
  displayName: string;
  /** Short description shown on the model card. */
  description: string;
  /** Which backend provider actually does the work. */
  provider:
    | 'useapi.seedance'
    | 'useapi.nano_banana'
    | 'useapi.kling'
    | 'useapi.runway'
    | 'useapi.pixverse'
    | 'useapi.veo'
    | 'useapi.minimax'
    | 'byok.heygen'
    | 'byok.openai_image'
    | 'byok.anthropic_claude'
    | 'byok.elevenlabs';
  mode: ProviderMode;
  /** Number of credits this action burns. Only meaningful for `mode: 'credits'`. */
  credits: number;
  /**
   * What a user would pay to run the same action directly on the
   * provider's official API. Used for the "You save X%" badge.
   * Null when the model is BYOK (user is already paying direct).
   */
  retailUsdPerAction: number | null;
  /** Which pipeline family this model belongs to. */
  family: PipelineFamily;
  /** Marketing sub-label ("Premium quality", "Fastest", etc.). */
  qualityTier: 'value' | 'balanced' | 'premium';
}

/**
 * The catalog. Order matters — this is what the frontend renders in
 * the model picker, top-to-bottom.
 */
export const CREDIT_MODELS: readonly CreditModel[] = [
  // ---------------- UGC family ----------------
  {
    id: 'seedance-2-5-ugc',
    displayName: 'Seedance 2.5',
    description:
      'ByteDance Seedance 2.5 lip-synced UGC video, up to 30 seconds. Great quality, our default UGC engine.',
    provider: 'useapi.seedance',
    mode: 'credits',
    credits: 40,
    retailUsdPerAction: 4.5,
    family: 'ugc',
    qualityTier: 'balanced',
  },
  {
    id: 'heygen-avatar-iv',
    displayName: 'HeyGen Avatar IV',
    description:
      'Premium lip-sync quality with HeyGen. Bring your own key. Best quality when brand consistency matters.',
    provider: 'byok.heygen',
    mode: 'byok',
    credits: 0,
    retailUsdPerAction: null,
    family: 'ugc',
    qualityTier: 'premium',
  },
  {
    id: 'kling-o3-ugc',
    displayName: 'Kling Pro',
    description: 'Kling Pro 5-second video. Very high prompt adherence.',
    provider: 'useapi.kling',
    mode: 'credits',
    credits: 20,
    retailUsdPerAction: 0.7,
    family: 'ugc',
    qualityTier: 'premium',
  },
  {
    id: 'kling-standard-ugc',
    displayName: 'Kling Standard',
    description: 'Kling Standard 5-second video. Balanced quality/cost.',
    provider: 'useapi.kling',
    mode: 'credits',
    credits: 10,
    retailUsdPerAction: 0.35,
    family: 'ugc',
    qualityTier: 'balanced',
  },
  {
    id: 'runway-gen4-lipsync',
    displayName: 'Runway Gen-4 Lip-Sync',
    description: 'Runway Gen-4 lip-sync 5-second video.',
    provider: 'useapi.runway',
    mode: 'credits',
    credits: 15,
    retailUsdPerAction: 0.5,
    family: 'ugc',
    qualityTier: 'balanced',
  },
  {
    id: 'pixverse-v6-ugc',
    displayName: 'PixVerse v6',
    description: 'PixVerse v6 5-second video. Fastest of the credit models.',
    provider: 'useapi.pixverse',
    mode: 'credits',
    credits: 10,
    retailUsdPerAction: 0.3,
    family: 'ugc',
    qualityTier: 'value',
  },
  {
    id: 'minimax-hailuo-ugc',
    displayName: 'MiniMax Hailuo',
    description: 'MiniMax Hailuo 6-second video.',
    provider: 'useapi.minimax',
    mode: 'credits',
    credits: 12,
    retailUsdPerAction: 0.28,
    family: 'ugc',
    qualityTier: 'value',
  },
  {
    id: 'veo-3-fast',
    displayName: 'Google Veo 3 Fast',
    description: 'Google Veo 3 Fast 5-second video. Cinematic quality.',
    provider: 'useapi.veo',
    mode: 'credits',
    credits: 25,
    retailUsdPerAction: 3.75,
    family: 'ugc',
    qualityTier: 'premium',
  },

  // ---------------- Static-ad image family ----------------
  {
    id: 'nano-banana-static',
    displayName: 'Nano Banana',
    description:
      'Google Nano Banana (Gemini 2.5 Flash Image). Default image model — fast, cheap, high quality.',
    provider: 'useapi.nano_banana',
    mode: 'credits',
    credits: 2,
    retailUsdPerAction: 0.04,
    family: 'static',
    qualityTier: 'balanced',
  },
  {
    id: 'openai-gpt-image-2',
    displayName: 'OpenAI gpt-image-2',
    description:
      'OpenAI gpt-image-2. Bring your own key. Best when you need a specific style OpenAI does better.',
    provider: 'byok.openai_image',
    mode: 'byok',
    credits: 0,
    retailUsdPerAction: null,
    family: 'static',
    qualityTier: 'premium',
  },

  // ---------------- Copywriting (Claude) ----------------
  {
    id: 'claude-opus-copy',
    displayName: 'Claude Opus (copy variants)',
    description: 'Anthropic Claude Opus for headline + primary-text variant generation. BYOK.',
    provider: 'byok.anthropic_claude',
    mode: 'byok',
    credits: 0,
    retailUsdPerAction: null,
    family: 'variations',
    qualityTier: 'premium',
  },

  // ---------------- Voice ----------------
  {
    id: 'elevenlabs-tts',
    displayName: 'ElevenLabs TTS',
    description: 'ElevenLabs text-to-speech for UGC voiceovers. BYOK.',
    provider: 'byok.elevenlabs',
    mode: 'byok',
    credits: 0,
    retailUsdPerAction: null,
    family: 'ugc',
    qualityTier: 'balanced',
  },
] as const;

/** Lookup by stable id. Throws when the id is unknown. */
export function getCreditModel(id: string): CreditModel {
  const m = CREDIT_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown credit model id: ${id}`);
  return m;
}

/**
 * User-facing dollar cost of one action on this model. Returns 0 for
 * BYOK models (user pays their provider directly, not us).
 */
export function userDollarCost(model: CreditModel): number {
  if (model.mode === 'byok') return 0;
  return round2(model.credits * CREDIT_UNIT_USD);
}

/**
 * How much the user saves vs running this action on the provider's
 * official retail API. Returns 0 for BYOK models (they ARE paying
 * retail — no arbitrage on our side). Returns 0 (not negative) when
 * our credit cost happens to match retail, so the UI never renders
 * a "you save 0%" badge that reads like a bug.
 */
export function savingsUsd(model: CreditModel): number {
  if (model.mode === 'byok' || model.retailUsdPerAction == null) return 0;
  const savings = model.retailUsdPerAction - userDollarCost(model);
  return savings > 0 ? round2(savings) : 0;
}

/** Percent savings (0-100). See `savingsUsd` for BYOK handling. */
export function savingsPct(model: CreditModel): number {
  if (model.mode === 'byok' || model.retailUsdPerAction == null) return 0;
  const savings = savingsUsd(model);
  if (savings <= 0) return 0;
  return Math.round((savings / model.retailUsdPerAction) * 100);
}

/**
 * Convert USD → credits (for top-up UX). Rounds down so a $10 top-up
 * always resolves to a whole-credit count (500 in this case).
 */
export function usdToCredits(usd: number): number {
  return Math.floor(usd / CREDIT_UNIT_USD);
}

/**
 * Fixed top-up packs sold on Whop. The volume-discount pack gives a
 * bonus (not a per-credit discount) so the base credit price stays
 * consistent across all in-app displays.
 */
export const CREDIT_TOPUP_PACKS = [
  { sku: 'credits-500', usd: 10, credits: 500, bonusCredits: 0, label: '500 credits' },
  { sku: 'credits-2500', usd: 50, credits: 2500, bonusCredits: 0, label: '2,500 credits' },
  {
    sku: 'credits-10000',
    usd: 200,
    credits: 10000,
    bonusCredits: 2500,
    label: '10,000 credits + 2,500 bonus',
  },
] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
