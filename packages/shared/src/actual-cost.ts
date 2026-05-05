/**
 * Actual cost calculators for Phase 3b live API responses.
 *
 * Estimate (cost-estimation.ts) is what we tell the operator BEFORE the
 * job runs. Actual is what the API responses tell us AFTER. We track both
 * — `generation_jobs.estimated_cost_usd` is set at submit, `actual_cost_usd`
 * is incremented as each step completes.
 *
 * Pricing snapshot (May 2025). Re-pin before any major Phase 3b run; AI
 * provider pricing moves often.
 *
 * Sources:
 *   - Gemini 2.5 Flash:        $0.30/1M input, $2.50/1M output (text)
 *                              $0.04/image (gemini-2.5-flash-image, "nano-banana")
 *                              vision counts as input tokens (image+video frames tokenized)
 *   - Claude Sonnet 4:         $3.00/1M input, $15.00/1M output
 *   - Kie.ai Sora 2:           $1.50 per 15s video (estimate; check kie.ai/pricing)
 *   - HeyGen:                  $0.30 per video (estimate; varies by length+plan)
 *
 * Pure functions. No I/O. Test-pinned in `actual-cost.test.ts`.
 */

const ONE_MILLION = 1_000_000;

export const PRICING_SNAPSHOT = {
  gemini25Flash: {
    inputUsdPerM: 0.3,
    outputUsdPerM: 2.5,
  },
  gemini25FlashImage: {
    perImageUsd: 0.04,
  },
  claudeSonnet4: {
    inputUsdPerM: 3.0,
    outputUsdPerM: 15.0,
  },
  kieAiSora2: {
    perVideoUsd: 1.5,
  },
  heygen: {
    perVideoUsd: 0.3,
  },
} as const;

/**
 * Compute cost from Gemini's `usageMetadata` field (text-only and vision
 * calls return the same shape; image gen returns an empty/null usage and
 * gets a flat `gemini25FlashImage.perImageUsd` instead).
 */
export function computeGeminiTextCost(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}): number {
  const input = usage.promptTokenCount ?? 0;
  const output = usage.candidatesTokenCount ?? 0;
  const cost =
    (input / ONE_MILLION) * PRICING_SNAPSHOT.gemini25Flash.inputUsdPerM +
    (output / ONE_MILLION) * PRICING_SNAPSHOT.gemini25Flash.outputUsdPerM;
  return round4(cost);
}

/** Flat per-image price for nano-banana. Multiply by N images returned. */
export function computeGeminiImageCost(imageCount: number): number {
  return round4(imageCount * PRICING_SNAPSHOT.gemini25FlashImage.perImageUsd);
}

/** Compute Claude cost from `usage.input_tokens` + `usage.output_tokens`. */
export function computeClaudeCost(usage: {
  input_tokens?: number;
  output_tokens?: number;
}): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cost =
    (input / ONE_MILLION) * PRICING_SNAPSHOT.claudeSonnet4.inputUsdPerM +
    (output / ONE_MILLION) * PRICING_SNAPSHOT.claudeSonnet4.outputUsdPerM;
  return round4(cost);
}

/** Flat per-video for Kie.ai Sora 2. */
export function computeKieAiCost(): number {
  return round4(PRICING_SNAPSHOT.kieAiSora2.perVideoUsd);
}

/** Flat per-video for HeyGen. */
export function computeHeygenCost(): number {
  return round4(PRICING_SNAPSHOT.heygen.perVideoUsd);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
