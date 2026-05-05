/**
 * Pure-function cost estimation for AI generation jobs.
 *
 * Drives both the client-side live estimator (display in the request UI as
 * the operator changes count + provider) and the server-side guard (writes
 * estimated_cost_usd to generation_jobs before the Inngest job runs).
 *
 * Pricing assumptions are documented per-line and pinned by tests. They
 * reflect Phase 3a-era public pricing (May 2025); Phase 3b should re-pin
 * before live calls go out.
 *
 * IMPORTANT: this module is pure (no env, no DB, no I/O) so it can run on
 * client AND server without bundler complaints. Don't add imports beyond
 * the type-only import below.
 */

export type ConceptType = 'static' | 'ugc';
export type UgcVideoProvider = 'kie_ai' | 'heygen' | 'arcads';

/**
 * Per-output prices in USD. Keep in sync with the comments in
 * apps/web/app/concepts/[id]/generate (where the breakdown is shown to
 * the operator) and the test suite.
 */
const PRICING = {
  // Static path: Gemini Image (image gen) + Claude (copy refinement) +
  // Gemini Vision one-shot reference analysis at the start of the job.
  staticImagePerVariantUsd: 0.04,
  staticCopyPerVariantUsd: 0.02,
  staticReferenceAnalysisUsd: 0.05,

  // UGC path: Gemini Vision one-shot, then Claude prompt refinement per
  // variant, then provider video gen per variant.
  ugcVisionAnalysisUsd: 0.1,
  ugcPromptRefinementPerVariantUsd: 0.05,
  ugcVideoPerVariantUsd: {
    kie_ai: 1.5, // Sora 2 15s clip estimate
    heygen: 0.3,
    arcads: 0.5,
  } satisfies Record<UgcVideoProvider, number>,
} as const;

export interface CostBreakdownItem {
  item: string;
  cost: number;
}

export interface CostEstimate {
  estimateUsd: number;
  breakdown: CostBreakdownItem[];
}

export interface EstimateInput {
  conceptType: ConceptType;
  variantCount: number;
  /** UGC-only. Ignored for static. */
  provider?: UgcVideoProvider;
}

export function estimateGenerationCost(input: EstimateInput): CostEstimate {
  const { conceptType, variantCount } = input;
  const breakdown: CostBreakdownItem[] = [];

  if (conceptType === 'static') {
    breakdown.push({
      item: `Image generation (${variantCount} × $${PRICING.staticImagePerVariantUsd.toFixed(2)})`,
      cost: round4(variantCount * PRICING.staticImagePerVariantUsd),
    });
    breakdown.push({
      item: `Copy refinement (${variantCount} × $${PRICING.staticCopyPerVariantUsd.toFixed(2)})`,
      cost: round4(variantCount * PRICING.staticCopyPerVariantUsd),
    });
    breakdown.push({
      item: 'Reference analysis (one-shot)',
      cost: PRICING.staticReferenceAnalysisUsd,
    });
  } else {
    if (!input.provider) {
      throw new Error('UGC cost estimate requires a provider.');
    }
    const videoUnit = PRICING.ugcVideoPerVariantUsd[input.provider];
    breakdown.push({
      item: 'Vision analysis (one-shot)',
      cost: PRICING.ugcVisionAnalysisUsd,
    });
    breakdown.push({
      item: `Prompt refinement (${variantCount} × $${PRICING.ugcPromptRefinementPerVariantUsd.toFixed(2)})`,
      cost: round4(variantCount * PRICING.ugcPromptRefinementPerVariantUsd),
    });
    breakdown.push({
      item: `${labelForProvider(input.provider)} video gen (${variantCount} × $${videoUnit.toFixed(2)})`,
      cost: round4(variantCount * videoUnit),
    });
  }

  const estimateUsd = round4(breakdown.reduce((sum, b) => sum + b.cost, 0));
  return { estimateUsd, breakdown };
}

export function labelForProvider(provider: UgcVideoProvider): string {
  switch (provider) {
    case 'kie_ai':
      return 'Kie.ai (Sora 2)';
    case 'heygen':
      return 'HeyGen';
    case 'arcads':
      return 'Arcads';
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
