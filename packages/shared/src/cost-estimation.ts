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
// Polish-4: creative format. avatar_talking_head=HeyGen avatar mode;
// cinematic_voiceover=Kling 2.5 cinematic clips + ElevenLabs TTS.
export type CreativeFormat = 'avatar_talking_head' | 'cinematic_voiceover';

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

  // Polish-4: cinematic_voiceover format costs. Polish-9.17: bumped
  // Kling per-clip from $0.30 (kling-v2.5-turbo-pro) to $0.35
  // (kling-v2.6, the audio-capable model). ElevenLabs TTS ≈
  // $0.005-0.02 per ad-length script (~200 chars/variant by default).
  // Cinematic prompt builder adds a small Claude call (~$0.01).
  cinematicKlingPerVariantUsd: 0.35,
  cinematicTtsPerVariantUsd: 0.06, // 200 chars × $0.30/1k chars
  cinematicPromptBuildPerVariantUsd: 0.01,

  // Polish-6 / Polish-9.17: Kling 2.6 multi-clip (16 clips per
  // variant, $0.35/clip on kwaivgi/kling-v2.6).
  klingMultiClipClipsPerVariant: 16,
  klingMultiClipPerClipUsd: 0.35,

  // Polish-10 / Polish-10.1: Kling 3.0 Omni multi-segment pipeline.
  // Default mode dropped pro→standard for cheaper iteration (720p is
  // indistinguishable from 1080p on phone viewers for 9:16 UGC).
  //   2 segments × 15s × $0.224/sec (standard + audio) = $6.72 of Kling
  //   + ~$0.05 Nano Banana reference frame
  //   + ~$0.05 stitch crossfade
  //   + ~$0.10 production manual (Claude)
  //   ≈ $6.92 per variant (was ~$8.50 in pro). Pro pricing still
  // available on the kling-omni client for explicit overrides.
  klingOmniSegmentsPerVariant: 2,
  klingOmniSegmentDurationSec: 15,
  klingOmniPerSegmentUsd: 3.36, // standard mode: 0.224 × 15
  klingOmniReferenceFrameUsd: 0.05,
  klingOmniStitchUsd: 0.05,
  klingOmniManualPromptUsd: 0.1,
  klingMultiClipManualPromptUsd: 0.1,
  // Polish-6: Sora 2 single-shot via Kie.ai
  soraPerVariantUsd: 1.5,
  soraPromptUsd: 0.05,
  // Polish-6: Nano Banana static image
  nanoBananaPerVariantUsd: 0.04,
  nanoBananaClaudeUsd: 0.02,
} as const;

export interface CostBreakdownItem {
  item: string;
  cost: number;
}

export interface CostEstimate {
  estimateUsd: number;
  breakdown: CostBreakdownItem[];
}

// Polish-6: pipeline-level cost estimation. These map to the routed
// pipelines from pipeline-router.ts. When pipeline is set, it takes
// precedence over format + provider.
export type PipelineType =
  | 'heygen_avatar_talking_head'
  | 'sora_2_single_shot'
  | 'kling_3_multi_clip_native_lipsync'
  | 'kling_3_omni_multi_segment'
  | 'nano_banana_static_image';

export interface EstimateInput {
  conceptType: ConceptType;
  variantCount: number;
  /** UGC-only. Ignored for static. */
  provider?: UgcVideoProvider;
  /**
   * Polish-4: when format='cinematic_voiceover' the UGC pipeline uses
   * Kling + ElevenLabs instead of HeyGen, with different per-variant
   * costs. Defaults to 'avatar_talking_head' if omitted.
   */
  format?: CreativeFormat;
  /** Polish-6: pipeline-level cost. Overrides format + provider when set. */
  pipeline?: PipelineType;
}

export function estimateGenerationCost(input: EstimateInput): CostEstimate {
  const { conceptType, variantCount } = input;
  const breakdown: CostBreakdownItem[] = [];

  // Polish-9.4: pipeline drives provider. Server call sites (the create-
  // job action) and clients that only know the picked pipeline can
  // omit `provider` — we derive it from the descriptor. Legacy callers
  // that pass only `provider` still work via the else-branch below.
  const effectiveProvider: UgcVideoProvider | undefined =
    input.provider ?? providerFromPipeline(input.pipeline);

  // Polish-6: pipeline-level estimation takes precedence when set.
  if (input.pipeline) {
    return estimateByPipeline(input.pipeline, variantCount);
  }

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
  } else if (input.format === 'cinematic_voiceover') {
    // Polish-4: Kling + ElevenLabs + cinematic prompt builder. No HeyGen
    // avatar selection, no Sora prompt refinement — Claude builds the
    // visual prompt directly from the script.
    breakdown.push({
      item: 'Vision analysis (one-shot)',
      cost: PRICING.ugcVisionAnalysisUsd,
    });
    breakdown.push({
      item: `Cinematic prompt build (${variantCount} × $${PRICING.cinematicPromptBuildPerVariantUsd.toFixed(2)})`,
      cost: round4(variantCount * PRICING.cinematicPromptBuildPerVariantUsd),
    });
    breakdown.push({
      item: `Kling 2.6 video (${variantCount} × $${PRICING.cinematicKlingPerVariantUsd.toFixed(2)})`,
      cost: round4(variantCount * PRICING.cinematicKlingPerVariantUsd),
    });
    breakdown.push({
      item: `ElevenLabs voiceover (${variantCount} × $${PRICING.cinematicTtsPerVariantUsd.toFixed(2)})`,
      cost: round4(variantCount * PRICING.cinematicTtsPerVariantUsd),
    });
  } else {
    // Polish-9.4: throw only when BOTH provider AND pipeline are missing.
    // The pipeline branch up top already returned, so reaching here with
    // a pipeline value would mean a pipeline we don't have a UGC-video
    // unit price for — defensive guard for that edge too.
    if (!effectiveProvider) {
      throw new Error('UGC cost estimate requires a provider.');
    }
    const videoUnit = PRICING.ugcVideoPerVariantUsd[effectiveProvider];
    breakdown.push({
      item: 'Vision analysis (one-shot)',
      cost: PRICING.ugcVisionAnalysisUsd,
    });
    breakdown.push({
      item: `Prompt refinement (${variantCount} × $${PRICING.ugcPromptRefinementPerVariantUsd.toFixed(2)})`,
      cost: round4(variantCount * PRICING.ugcPromptRefinementPerVariantUsd),
    });
    breakdown.push({
      item: `${labelForProvider(effectiveProvider)} video gen (${variantCount} × $${videoUnit.toFixed(2)})`,
      cost: round4(variantCount * videoUnit),
    });
  }

  const estimateUsd = round4(breakdown.reduce((sum, b) => sum + b.cost, 0));
  return { estimateUsd, breakdown };
}

/**
 * Polish-9.4: map a PipelineType to its corresponding UgcVideoProvider
 * when one exists. Used by estimateGenerationCost to derive provider
 * when a caller passes only pipeline. Inlined here (rather than imported
 * from pipeline-descriptors.ts) to avoid a circular module dependency
 * — pipeline-descriptors imports PipelineType FROM this file.
 *
 * Note: only heygen_avatar_talking_head maps to a value that exists in
 * the legacy UgcVideoProvider enum. kling/sora/gemini pipelines hit the
 * estimateByPipeline branch first and never reach the UGC-provider
 * fallback, so they're intentionally not mapped here.
 */
function providerFromPipeline(pipeline: PipelineType | undefined): UgcVideoProvider | undefined {
  if (pipeline === 'heygen_avatar_talking_head') return 'heygen';
  return undefined;
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

function estimateByPipeline(pipeline: PipelineType, variantCount: number): CostEstimate {
  const breakdown: CostBreakdownItem[] = [];
  switch (pipeline) {
    case 'heygen_avatar_talking_head': {
      const videoUnit = PRICING.ugcVideoPerVariantUsd.heygen;
      breakdown.push({ item: 'Vision analysis', cost: PRICING.ugcVisionAnalysisUsd });
      breakdown.push({
        item: `Prompt refinement (${variantCount} × $${PRICING.ugcPromptRefinementPerVariantUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.ugcPromptRefinementPerVariantUsd),
      });
      breakdown.push({
        item: `HeyGen video (${variantCount} × $${videoUnit.toFixed(2)})`,
        cost: round4(variantCount * videoUnit),
      });
      break;
    }
    case 'sora_2_single_shot':
      breakdown.push({
        item: `Sora prompt (${variantCount} × $${PRICING.soraPromptUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.soraPromptUsd),
      });
      breakdown.push({
        item: `Sora 2 video (${variantCount} × $${PRICING.soraPerVariantUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.soraPerVariantUsd),
      });
      break;
    case 'kling_3_multi_clip_native_lipsync': {
      const clips = PRICING.klingMultiClipClipsPerVariant;
      const totalClips = variantCount * clips;
      breakdown.push({
        item: 'Production manual (Claude)',
        cost: PRICING.klingMultiClipManualPromptUsd,
      });
      breakdown.push({
        item: `Kling 2.6 clips (${totalClips} clips × $${PRICING.klingMultiClipPerClipUsd.toFixed(2)})`,
        cost: round4(totalClips * PRICING.klingMultiClipPerClipUsd),
      });
      break;
    }
    case 'kling_3_omni_multi_segment': {
      const segmentsPerVariant = PRICING.klingOmniSegmentsPerVariant;
      const totalSegments = variantCount * segmentsPerVariant;
      breakdown.push({
        item: 'Production manual (Claude)',
        cost: round4(variantCount * PRICING.klingOmniManualPromptUsd),
      });
      breakdown.push({
        item: `Reference frames (${variantCount} × $${PRICING.klingOmniReferenceFrameUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.klingOmniReferenceFrameUsd),
      });
      breakdown.push({
        item: `Kling 3.0 Omni segments (standard, ${totalSegments} × $${PRICING.klingOmniPerSegmentUsd.toFixed(2)})`,
        cost: round4(totalSegments * PRICING.klingOmniPerSegmentUsd),
      });
      breakdown.push({
        item: `Crossfade stitch (${variantCount} × $${PRICING.klingOmniStitchUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.klingOmniStitchUsd),
      });
      break;
    }
    case 'nano_banana_static_image':
      breakdown.push({
        item: `Claude descriptions (${variantCount} × $${PRICING.nanoBananaClaudeUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.nanoBananaClaudeUsd),
      });
      breakdown.push({
        item: `Gemini images (${variantCount} × $${PRICING.nanoBananaPerVariantUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.nanoBananaPerVariantUsd),
      });
      break;
  }
  const estimateUsd = round4(breakdown.reduce((sum, b) => sum + b.cost, 0));
  return { estimateUsd, breakdown };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
