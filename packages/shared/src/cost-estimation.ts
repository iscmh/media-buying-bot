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

import {
  MODEL_PROVIDER_CONFIGS,
  VIDEO_MODELS,
  computeSegmentCountForModel,
  getDefaultProviderForModel,
  getModelProviderConfig,
  getVideoModel,
  type VideoModelId,
  type VideoProviderId,
} from './video-models';

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

  // Polish-11: continuous TTS + lipsync layer added to the multi-clip
  // pipeline. ElevenLabs cost is ~200 chars per variant at $0.30/1k
  // chars = $0.06; lipsync cost on Replicate varies by model
  // (~$0.50-1.50 per ~30s output). Both are env-tunable on the
  // ai-providers clients.
  klingMultiClipTtsPerVariantUsd: 0.06,
  klingMultiClipLipsyncPerVariantUsd: 1.0,

  // Polish-12: kie.ai Gemini Omni Flash native pipeline. One 10s
  // 1080p generation = $0.90 (Nov 2026 kie.ai pricing) + $0.05 Nano
  // Banana reference frame. Collapses the Polish-11 multi-clip +
  // ElevenLabs + lipsync stack into a single API call.
  kieOmniFlashPerVariantUsd: 0.9,
  kieOmniFlashReferenceFrameUsd: 0.05,
  kieOmniFlashManualPromptUsd: 0.05,
  // Polish-12.1: when 2+ segments, the existing Polish-9.12 idan054
  // ffmpeg-concat path stitches them.
  kieOmniFlashStitchUsd: 0.05,
  // Polish-12.4 / Polish-16: kie.ai character/create endpoint cost.
  // The docs page for the endpoint doesn't publish pricing. Initial
  // $0.15 placeholder hasn't been reconciled against actual dashboard
  // deductions in production yet; Polish-16 leaves it in place pending
  // a real billing data point.
  kieOmniFlashCharacterCreateUsd: 0.15,
  // Polish-12.8 v2 / Polish-16: anti-celebrity pre-validation overhead.
  // Reconciled from production observation — typical happy-path
  // generation lands a clean face on attempt 1 or 2 (~4 Gemini Vision
  // calls × ~$0.005 each = $0.02 expected case). The earlier $0.10
  // placeholder over-quoted by ~5x. The face-validation flow stays
  // bounded at MAX_NANO_BANANA_VALIDATION_ATTEMPTS=8, so the worst
  // case is still small absolute dollars.
  kieOmniFlashFaceValidationUsd: 0.02,
  // Polish-12.5 / Polish-16: per-chain-link frame extraction via the
  // Replicate ffmpeg-style utility model. Charged on N-1 segments.
  // Reconciled from the lucataco/frame-extractor model's published
  // pricing — the initial $0.02 placeholder was ~200× the actual
  // ~$0.0001 per call. Override via REPLICATE_FRAME_EXTRACT_COST_USD
  // env to track a different picked model's rate.
  kieOmniFlashFrameExtractUsd: 0.0001,

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
  // Polish-19: kie.ai Kling Avatar v2 (Pro) pipeline. Per-second
  // pricing on the model itself, plus a fixed Claude script ($0.05),
  // a fixed Nano Banana reference frame ($0.05), and a per-char
  // ElevenLabs TTS estimate. Script length defaults to the audio
  // duration's worth of natural-speech words (≈150 wpm → ~3 chars/sec
  // when projecting back into chars/sec). Worst case 30s ≈ 400 chars
  // ≈ $0.12 of ElevenLabs.
  kieKlingAvatarUsdPerSecond: 0.115,
  kieKlingAvatarClaudeScriptUsd: 0.05,
  kieKlingAvatarReferenceFrameUsd: 0.05,
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
  | 'kie_omni_flash_native'
  | 'kie_kling_avatar_v2_standard'
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
  /**
   * Polish-12.1: target dialogue duration in seconds, used by the
   * kie_omni_flash_native branch to size segment count (1 / 2 / 3).
   * When omitted that branch defaults to the worst case (3 segments)
   * so the upfront estimate never under-quotes the variant.
   */
  estimatedDurationSeconds?: number;
  /**
   * Polish-14.1: actual source video duration in seconds, detected
   * client-side from the uploaded creative. Wins over
   * estimatedDurationSeconds when present so the form's upfront cost
   * preview matches what the worker actually generates. Missing →
   * falls back to estimatedDurationSeconds → 30s default.
   */
  sourceDurationSeconds?: number;
  /**
   * Polish-20: descriptor-driven cost path. When present, wins over
   * `pipeline` / `provider` / `format` — the estimator hits the
   * (modelId × providerId) ModelProviderConfig for its per-second
   * price and segment math. The form uses this exclusively from
   * Polish-20 onward; legacy branches (Kling Avatar v2, Omni Flash,
   * etc.) are retained through Commit 4 removal.
   */
  videoModelId?: VideoModelId;
  videoProviderId?: VideoProviderId;
}

export function estimateGenerationCost(input: EstimateInput): CostEstimate {
  const { conceptType, variantCount } = input;
  const breakdown: CostBreakdownItem[] = [];

  // Polish-20: descriptor-driven path wins over legacy pipeline branches.
  // When Commit 3+4 remove the legacy pipelines, all UGC callers will
  // route through here.
  if (input.videoModelId) {
    return estimateByVideoModel({
      modelId: input.videoModelId,
      // Default provider = cheapest live provider for the model. Polish-20
      // launch: always kie.ai (only live provider). Polish-21+ callers
      // that let the user pick pass providerId explicitly.
      providerId: input.videoProviderId ?? getDefaultProviderForModel(input.videoModelId)?.id,
      variantCount,
      // Polish-14.1: sourceDurationSeconds wins over estimatedDurationSeconds.
      targetSeconds: input.sourceDurationSeconds ?? input.estimatedDurationSeconds,
    });
  }

  // Polish-9.4: pipeline drives provider. Server call sites (the create-
  // job action) and clients that only know the picked pipeline can
  // omit `provider` — we derive it from the descriptor. Legacy callers
  // that pass only `provider` still work via the else-branch below.
  const effectiveProvider: UgcVideoProvider | undefined =
    input.provider ?? providerFromPipeline(input.pipeline);

  // Polish-6: pipeline-level estimation takes precedence when set.
  if (input.pipeline) {
    // Polish-14.1: sourceDurationSeconds wins over estimatedDurationSeconds.
    return estimateByPipeline(
      input.pipeline,
      variantCount,
      input.sourceDurationSeconds ?? input.estimatedDurationSeconds,
    );
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

function estimateByPipeline(
  pipeline: PipelineType,
  variantCount: number,
  estimatedDurationSeconds: number | undefined,
): CostEstimate {
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
      // Polish-11: continuous TTS + lipsync layer. Estimates are
      // rough (~200 char dialogue per variant × $0.30/1k chars + a
      // single lipsync pass on the stitched composite); env override
      // tunes both costs at runtime.
      breakdown.push({
        item: `ElevenLabs voiceover (${variantCount} × $${PRICING.klingMultiClipTtsPerVariantUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.klingMultiClipTtsPerVariantUsd),
      });
      breakdown.push({
        item: `Lipsync (${variantCount} × $${PRICING.klingMultiClipLipsyncPerVariantUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.klingMultiClipLipsyncPerVariantUsd),
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
    case 'kie_omni_flash_native': {
      // Polish-12.1 / Polish-14: cost scales linearly with segment
      // count via ceiling-divide (1 segment per 10s of dialogue),
      // capped at the worker's sanity ceiling of 30 segments (5 min).
      // When estimatedDurationSeconds is omitted the form quotes
      // 30s up front (3 segments) — the most common UGC length and
      // matches the legacy quote for back-compat.
      const seconds = estimatedDurationSeconds ?? 30;
      const segmentCount = Math.min(Math.max(1, Math.ceil(seconds / 10)), 30);
      const totalSegments = variantCount * segmentCount;
      const stitchCount = segmentCount >= 2 ? variantCount : 0;
      breakdown.push({
        item: `Production manual (Claude, ${variantCount} × $${PRICING.kieOmniFlashManualPromptUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.kieOmniFlashManualPromptUsd),
      });
      breakdown.push({
        item: `Reference frames (${variantCount} × $${PRICING.kieOmniFlashReferenceFrameUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.kieOmniFlashReferenceFrameUsd),
      });
      // Polish-12.8 v2: anti-celeb face pre-screen overhead. Bills
      // even when the validator skips on a clean first attempt; the
      // averaging across retries makes this a stable estimate.
      breakdown.push({
        item: `Face validation (anti-celeb pre-screen) (${variantCount} × $${PRICING.kieOmniFlashFaceValidationUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.kieOmniFlashFaceValidationUsd),
      });
      // Polish-12.4: kie.ai character registration. One per variant.
      breakdown.push({
        item: `kie.ai character registration (${variantCount} × $${PRICING.kieOmniFlashCharacterCreateUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.kieOmniFlashCharacterCreateUsd),
      });
      breakdown.push({
        item: `Gemini Omni Flash (${totalSegments} segment${
          totalSegments === 1 ? '' : 's'
        } × $${PRICING.kieOmniFlashPerVariantUsd.toFixed(2)})`,
        cost: round4(totalSegments * PRICING.kieOmniFlashPerVariantUsd),
      });
      // Polish-12.5: frame extraction for chain continuity. N-1 per
      // variant — the final segment's last frame is never extracted.
      const frameExtractCount = variantCount * Math.max(0, segmentCount - 1);
      if (frameExtractCount > 0) {
        breakdown.push({
          item: `Chain-continuity frame extracts (${frameExtractCount} × $${PRICING.kieOmniFlashFrameExtractUsd.toFixed(2)})`,
          cost: round4(frameExtractCount * PRICING.kieOmniFlashFrameExtractUsd),
        });
      }
      if (stitchCount > 0) {
        breakdown.push({
          item: `idan054 video stitching (${stitchCount} × $${PRICING.kieOmniFlashStitchUsd.toFixed(2)})`,
          cost: round4(stitchCount * PRICING.kieOmniFlashStitchUsd),
        });
      }
      break;
    }
    case 'kie_kling_avatar_v2_standard': {
      // Polish-19: single-call lipsync — one Kling generation per
      // variant, sized to the script's target duration. Defaults
      // mirror the Omni Flash branch (30s when nothing's specified)
      // so the same submit path lands consistent estimates.
      const seconds = estimatedDurationSeconds ?? 30;
      const klingUsd = round4(seconds * PRICING.kieKlingAvatarUsdPerSecond);
      // ~150 wpm × ~5 chars/word = ~750 chars/min = ~12.5 chars/sec.
      // Use 13 to stay slightly above for safety on the TTS estimate.
      const estimatedScriptChars = seconds * 13;
      const ttsPerVariant = round4(
        (estimatedScriptChars / 1000) * 0.3, // $0.30 / 1k chars (ElevenLabs)
      );
      breakdown.push({
        item: `Claude script (${variantCount} × $${PRICING.kieKlingAvatarClaudeScriptUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.kieKlingAvatarClaudeScriptUsd),
      });
      breakdown.push({
        item: `Nano Banana reference frame (${variantCount} × $${PRICING.kieKlingAvatarReferenceFrameUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.kieKlingAvatarReferenceFrameUsd),
      });
      breakdown.push({
        item: `ElevenLabs TTS (~${estimatedScriptChars} chars × $0.30/1k, ${variantCount} variants)`,
        cost: round4(variantCount * ttsPerVariant),
      });
      breakdown.push({
        item: `Kling Avatar v2 Pro (${seconds}s × $${PRICING.kieKlingAvatarUsdPerSecond.toFixed(3)}/sec, ${variantCount} variants)`,
        cost: round4(variantCount * klingUsd),
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

// =========================================================================
// Polish-20: descriptor-driven video-model cost estimator
// =========================================================================
//
// Cost per variant:
//   $0.05 Claude script (one call returns the segments[] array for the
//   whole variant) + total_output_seconds × usdPerSecond
//   + $0.15 Replicate ffmpeg-concat when segmentCount > 1.
//
// Segment count comes from computeSegmentCountForModel(model, target).
// Total billed seconds = segmentCount × model.maxSingleCallSeconds
// (each per-call submit runs at the model's per-call cap; last chunk
// is billed at the cap even if the user's target is slightly less).

const VIDEO_MODEL_CLAUDE_SCRIPT_USD = 0.05;
const VIDEO_MODEL_STITCH_USD = 0.15;
const VIDEO_MODEL_DEFAULT_TARGET_SECONDS = 30;

interface EstimateByVideoModelInput {
  modelId: VideoModelId;
  providerId: VideoProviderId | undefined;
  variantCount: number;
  targetSeconds?: number;
}

function estimateByVideoModel(input: EstimateByVideoModelInput): CostEstimate {
  const { modelId, variantCount } = input;
  const breakdown: CostBreakdownItem[] = [];
  const target = input.targetSeconds ?? VIDEO_MODEL_DEFAULT_TARGET_SECONDS;
  const model = getVideoModel(modelId);
  const config = input.providerId ? getModelProviderConfig(modelId, input.providerId) : undefined;

  // Defensive guard: unknown model or no live provider yields a zero
  // estimate so the form's cost display renders "$0.00" instead of
  // crashing. The estimator IS the source of truth for the daily-cap
  // check, so an unknown model can't accidentally allow spend either
  // — the worker refuses to run without a valid config.
  if (!model || !config) {
    return { estimateUsd: 0, breakdown: [] };
  }

  const segmentCount = computeSegmentCountForModel(model, target);
  const billedSecondsPerVariant = segmentCount * model.maxSingleCallSeconds;
  const totalSegments = variantCount * segmentCount;

  breakdown.push({
    item: `Claude segments script (${variantCount} × $${VIDEO_MODEL_CLAUDE_SCRIPT_USD.toFixed(2)})`,
    cost: round4(variantCount * VIDEO_MODEL_CLAUDE_SCRIPT_USD),
  });
  breakdown.push({
    item:
      `${model.displayName} (${totalSegments} segment${totalSegments === 1 ? '' : 's'} × ` +
      `${model.maxSingleCallSeconds}s × $${config.usdPerSecond.toFixed(3)}/sec)`,
    cost: round4(variantCount * billedSecondsPerVariant * config.usdPerSecond),
  });
  if (segmentCount > 1) {
    breakdown.push({
      item: `Replicate ffmpeg-concat (${variantCount} × $${VIDEO_MODEL_STITCH_USD.toFixed(2)})`,
      cost: round4(variantCount * VIDEO_MODEL_STITCH_USD),
    });
  }

  const estimateUsd = round4(breakdown.reduce((sum, b) => sum + b.cost, 0));
  return { estimateUsd, breakdown };
}

// Silences the linter for the config list — kept live so tests can
// assert the MODEL_PROVIDER_CONFIGS coverage matrix stays populated.
void MODEL_PROVIDER_CONFIGS;
void VIDEO_MODELS;
