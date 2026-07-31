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
// Polish-20 Commit 4: cinematic_voiceover format retired with the
// legacy Kling + ElevenLabs pipeline. avatar_talking_head is the
// only remaining format enum member (HeyGen avatar mode).
export type CreativeFormat = 'avatar_talking_head';

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

  // Polish-6: Sora 2 single-shot via Kie.ai
  soraPerVariantUsd: 1.5,
  soraPromptUsd: 0.05,
  // Polish-6: Nano Banana static image
  nanoBananaPerVariantUsd: 0.04,
  nanoBananaClaudeUsd: 0.02,
  // Polish-23 Commit 1: Higgsfield Soul via WaveSpeedAI + kie.ai
  // Veo 3.1 Lite. ONE Soul reference per BATCH (not per variant)
  // — the same PNG URL is threaded into every 8s Veo clip so
  // the character stays locked across the composite. Veo Lite
  // runs 35 credits × $0.005/credit at 1080p × 8 clips per 60s
  // = $1.40 per 60s ad (BCH's math). Higgsfield Soul at `high`
  // ($0.23/run) buys the locked-character-detail advantage the
  // operator explicitly requested. Batches larger than one
  // variant reuse the Soul reference — cost line lists the
  // batch-fixed items as `1 ×`.
  polish23HiggsfieldSoulHighUsdPerRun: 0.23,
  polish23HiggsfieldSoulMediumUsdPerRun: 0.09,
  polish23NanoBananaSeedUsd: 0.04,
  polish23ClaudeScriptUsd: 0.02,
  polish23VeoLite1080pUsdPerClip: 0.175,
  polish23VeoClipSeconds: 8,
  polish23ReplicateConcatUsd: 0.15,

  // Polish-25.3 Commit 18b + 18b-hotfix: OpenAI gpt-image-2
  // static-ad pipeline. Verified July 2026 pricing at 1024x1024:
  //   High:   $0.211/image
  //   Medium: $0.053/image
  //   Low:    $0.006/image
  // Plus a Claude copy rewrite (~$0.02/variant) that generates the
  // headline + primary text variations fed into the image edit.
  //
  // Constants mirror packages/ai-providers/src/openai-image-client.ts
  // — OPENAI_GPT_IMAGE_2_*_USD_PER_IMAGE. Kept duplicated here rather
  // than imported because @mbb/shared cannot depend on
  // @mbb/ai-providers (would circle the dep graph). Any change here
  // MUST land alongside the mirror constants in one commit.
  //
  // 18b-hotfix drift correction: Low was $0.02 (~3.3× too high),
  // Medium was $0.05, High was $0.20. Real pricing verified against
  // OpenAI's current pricing page.
  openaiStaticClaudeUsd: 0.02,
  openaiStaticImageHighUsd: 0.211,
  openaiStaticImageMediumUsd: 0.053,
  openaiStaticImageLowUsd: 0.006,
} as const;

/**
 * Polish-25.3 Commit 18b: quality tier for the OpenAI static-ad
 * pipeline. Mirrored from the ai-providers client's
 * OpenaiImageQuality union — kept as a plain string union here so
 * @mbb/shared has zero runtime imports from @mbb/ai-providers
 * (see PRICING comment above).
 */
export type OpenaiStaticImageQuality = 'low' | 'medium' | 'high';

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
  | 'nano_banana_static_image'
  // Polish-23 Commit 1: Higgsfield Soul via WaveSpeedAI + kie.ai
  // Veo 3.1 Lite 1080p × 8 clips per 60s composite. Reserved
  // here so the estimator + descriptor + form pickers stay in
  // lockstep before Commit 3 wires the worker.
  | 'polish23_higgsfield_veo_lite'
  // Polish-25 Commit 2: MakeUGC pre-cast avatar UGC ad. Single
  // video output ($0.0495 per 60s @ API Starter tier — 20-50x
  // cheaper than Polish-23/24). Character consistency guaranteed
  // via pre-cast avatar library.
  | 'polish25_makeugc'
  // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad.
  // Reference-image-anchored via /v1/images/edits — user uploads a
  // winning static image, Claude rewrites overlay copy, OpenAI
  // edits the image to match. Quality tier drives per-image cost
  // (low/medium/high), defaults to medium ($0.05) to match Instant
  // UGC per-variant economics.
  | 'static_openai_image';

export interface EstimateInput {
  conceptType: ConceptType;
  variantCount: number;
  /** UGC-only. Ignored for static. */
  provider?: UgcVideoProvider;
  /** Retained enum member: 'avatar_talking_head' (HeyGen). */
  format?: CreativeFormat;
  /** Polish-6: pipeline-level cost. Overrides format + provider when set. */
  pipeline?: PipelineType;
  /**
   * Polish-12.1: target dialogue duration in seconds. Passed through
   * to the descriptor-driven estimateByVideoModel path when
   * videoModelId is set; ignored by the surviving legacy branches
   * (heygen / sora / nano-banana all have flat per-variant pricing).
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
  /**
   * Polish-25.3 Commit 18b: quality tier for the OpenAI static-ad
   * pipeline. Only consulted when pipeline === 'static_openai_image';
   * ignored elsewhere. Defaults to 'medium' when omitted so the
   * preview number is stable across form re-mounts before the user
   * touches the quality selector.
   */
  openaiStaticQuality?: OpenaiStaticImageQuality;
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
      // Polish-25.3 Commit 18b: quality tier passed through only for
      // the static-openai branch; other branches ignore it.
      input.openaiStaticQuality,
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
  _estimatedDurationSeconds: number | undefined,
  openaiStaticQuality: OpenaiStaticImageQuality | undefined,
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
    case 'polish23_higgsfield_veo_lite': {
      // Polish-23 pipeline: ONE Higgsfield Soul reference PNG per
      // BATCH (not per variant) — same reference URL fed into
      // every Veo 3.1 Lite clip's imageUrls[0] so the character
      // stays locked across the composite.
      //
      //   Nano Banana seed (batch-fixed)          $0.04
      //   Higgsfield Soul high (batch-fixed)      $0.23
      //   Claude ad-spec × variantCount           $0.02 × N
      //   Veo Lite × ceil(target/8) × variantCount $0.175 × clips × N
      //   Replicate concat × variantCount         $0.15 × N
      //
      // 1 variant × 60s = $1.84 = $0.04 + $0.23 + $0.02 + $1.40 + $0.15.
      // BCH's $1.40 anchor lands on the Veo-only line.
      const target = _estimatedDurationSeconds ?? 60;
      const clipCount = Math.max(1, Math.ceil(target / PRICING.polish23VeoClipSeconds));
      const veoPerVariant = round4(clipCount * PRICING.polish23VeoLite1080pUsdPerClip);
      breakdown.push({
        item: `Nano Banana 2 seed image (1 × $${PRICING.polish23NanoBananaSeedUsd.toFixed(2)})`,
        cost: PRICING.polish23NanoBananaSeedUsd,
      });
      breakdown.push({
        item: `Higgsfield Soul reference (high, 1 × $${PRICING.polish23HiggsfieldSoulHighUsdPerRun.toFixed(2)})`,
        cost: PRICING.polish23HiggsfieldSoulHighUsdPerRun,
      });
      breakdown.push({
        item: `Claude ad-spec (${variantCount} × $${PRICING.polish23ClaudeScriptUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.polish23ClaudeScriptUsd),
      });
      breakdown.push({
        item: `Veo 3.1 Lite 1080p (${clipCount} clips × $${PRICING.polish23VeoLite1080pUsdPerClip.toFixed(3)}, ${variantCount} variants)`,
        cost: round4(variantCount * veoPerVariant),
      });
      breakdown.push({
        item: `Replicate ffmpeg-concat (${variantCount} × $${PRICING.polish23ReplicateConcatUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.polish23ReplicateConcatUsd),
      });
      break;
    }
    case 'static_openai_image': {
      // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static-ad
      // pipeline. Per-variant cost = Claude copy rewrite + one
      // OpenAI image edit. Quality tier drives the per-image
      // cost (low/medium/high). Defaults to medium ($0.05) —
      // matches the Instant UGC per-variant target.
      const q: OpenaiStaticImageQuality = openaiStaticQuality ?? 'medium';
      const perImage =
        q === 'high'
          ? PRICING.openaiStaticImageHighUsd
          : q === 'low'
            ? PRICING.openaiStaticImageLowUsd
            : PRICING.openaiStaticImageMediumUsd;
      breakdown.push({
        item: `Claude copy rewrite (${variantCount} × $${PRICING.openaiStaticClaudeUsd.toFixed(2)})`,
        cost: round4(variantCount * PRICING.openaiStaticClaudeUsd),
      });
      breakdown.push({
        item: `OpenAI gpt-image-2 ${q} (${variantCount} × $${perImage.toFixed(2)})`,
        cost: round4(variantCount * perImage),
      });
      break;
    }
    case 'polish25_makeugc': {
      // Polish-25 pipeline: single MakeUGC video per variant at
      // API Starter tier ($99/mo / 2000 credits = $0.0495/video).
      // Plus a tiny Claude condenser call (~$0.02) that rewrites
      // the source vision analysis into the ≤1500-char monologue.
      //
      //   Claude script condenser × variantCount   $0.02 × N
      //   MakeUGC video × variantCount             $0.0495 × N
      //
      // 1 variant × 60s = ~$0.07 total. 20-50x cheaper than
      // Polish-23 which spends ~$1.84 per 60s ad.
      const CLAUDE_CONDENSER_USD = 0.02;
      const MAKEUGC_STARTER_USD_PER_VIDEO = 99 / 2000; // $0.0495
      breakdown.push({
        item: `Claude script condenser (${variantCount} × $${CLAUDE_CONDENSER_USD.toFixed(2)})`,
        cost: round4(variantCount * CLAUDE_CONDENSER_USD),
      });
      breakdown.push({
        item: `Instant UGC pre-cast avatar video (${variantCount} × $${MAKEUGC_STARTER_USD_PER_VIDEO.toFixed(4)})`,
        cost: round4(variantCount * MAKEUGC_STARTER_USD_PER_VIDEO),
      });
      break;
    }
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
/**
 * Polish-21.0.8 hotfix: per-variant character reference image cost.
 *
 * Migrated from Nano Banana Pro (~$0.15/img) to Nano Banana 2
 * (~$0.08/img) after operator diagnosed the Pro API was silently
 * smart-downgrading UGC character faces (widespread April 2026
 * complaint pattern). Same Linda prompt, better model, half the
 * price + ~3× faster.
 *
 * Only billed on the Hedra Character 3 branch — that's the only
 * flow that generates a per-variant Nano Banana reference image.
 * Legacy kie.ai models produce text-to-video without a reference
 * image and don't hit this cost.
 */
export const VIDEO_MODEL_NANO_BANANA_PER_VARIANT_USD = 0.08;

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

  // Polish-21: Hedra models bill by ACTUAL audio duration, not by
  // the per-call cap. maxSingleCallSeconds is a hard limit, not a
  // billing unit for Hedra. The rest of the descriptor (seedance /
  // kling on kie.ai) charges the full per-call cap even when the
  // target is shorter, so we branch on the provider here rather
  // than adding a billsByActualDuration flag to VideoModel.
  //
  // Polish-21.0.9: broadened from modelId === 'hedra_character_3'
  // to providerId === 'hedra' so both Kling Avatar v2 variants
  // (Standard + Pro) get the same actual-duration billing +
  // Nano Banana 2 reference-image cost line as Character 3.
  const billsByActualDuration = config.providerId === 'hedra';

  const segmentCount = computeSegmentCountForModel(model, target);
  const billedSecondsPerVariant = billsByActualDuration
    ? Math.max(1, Math.round(target))
    : segmentCount * model.maxSingleCallSeconds;
  const totalSegments = variantCount * segmentCount;

  breakdown.push({
    item: `Claude segments script (${variantCount} × $${VIDEO_MODEL_CLAUDE_SCRIPT_USD.toFixed(2)})`,
    cost: round4(variantCount * VIDEO_MODEL_CLAUDE_SCRIPT_USD),
  });
  if (billsByActualDuration) {
    // Polish-21: Hedra ships one video per variant with cost driven
    // by audio length. Present as "variants × seconds" rather than
    // "segments × per-call cap".
    breakdown.push({
      item:
        `${model.displayName} (${variantCount} × ${billedSecondsPerVariant}s × ` +
        `~$${config.usdPerSecond.toFixed(3)}/sec)`,
      cost: round4(variantCount * billedSecondsPerVariant * config.usdPerSecond),
    });
    // Polish-21.0.8: Nano Banana 2 per-variant character reference
    // image. Was omitted from earlier Hedra estimates; adding here
    // so the operator's cost preview reflects the actual bot spend.
    breakdown.push({
      item: `Nano Banana 2 reference image (${variantCount} × $${VIDEO_MODEL_NANO_BANANA_PER_VARIANT_USD.toFixed(2)})`,
      cost: round4(variantCount * VIDEO_MODEL_NANO_BANANA_PER_VARIANT_USD),
    });
  } else {
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
  }

  const estimateUsd = round4(breakdown.reduce((sum, b) => sum + b.cost, 0));
  return { estimateUsd, breakdown };
}

// Silences the linter for the config list — kept live so tests can
// assert the MODEL_PROVIDER_CONFIGS coverage matrix stays populated.
void MODEL_PROVIDER_CONFIGS;
void VIDEO_MODELS;
