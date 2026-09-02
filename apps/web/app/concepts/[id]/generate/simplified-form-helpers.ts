/**
 * Polish-19 Commit 3 → Polish-20.0.1: pure helpers for the simplified
 * generation form.
 *
 * Post-Polish-20.0.1: the form picks a (model, provider) pair from
 * packages/shared/src/video-models.ts. Duration is auto-detected
 * from the source video (Polish-19.3.1 fallback chain) — the
 * simplified form no longer exposes a length picker. Advanced form
 * (/advanced) retains free-form entry for power users.
 */
import {
  computeSegmentCountForModel,
  formatModelCostHintPerVariant,
  getDefaultProviderForModel,
  getModelProviderConfig,
  getVideoModel,
  VIDEO_MODELS,
  type VideoModel,
  type VideoModelId,
  type VideoProviderId,
} from '@mbb/shared';

// Polish-21: the simplified form only surfaces launcher-visible
// models. seedance/kling/seedance_2 are retained in the shared
// descriptor through Polish-21 Commit 3 (worker + tests still
// reference their config lookups) but are marked
// hiddenFromLauncher: true so the picker doesn't show them.
export const LAUNCHER_VISIBLE_MODELS: readonly VideoModel[] = VIDEO_MODELS.filter(
  (m) => !m.hiddenFromLauncher,
);

// Re-export the shared descriptor bits the form component needs so
// the component file only imports from a single module.
export {
  VIDEO_MODELS,
  computeSegmentCountForModel,
  formatModelCostHintPerVariant,
  getDefaultProviderForModel,
  getModelProviderConfig,
  getVideoModel,
};
export type { VideoModel, VideoModelId, VideoProviderId };

/** Variant-count picker bounds. Min 1, max enforced server-side. */
export const SIMPLIFIED_MIN_VARIANTS = 1;
export const SIMPLIFIED_MAX_VARIANTS = 10;
export const SIMPLIFIED_DEFAULT_VARIANTS = 5;

/**
 * Polish-20.0.1: fallback target duration when the source video hasn't
 * been analyzed / duration wasn't detected. Matches the worker's
 * resolveAutoVideoDuration default so the form's cost preview lines
 * up with what the worker will actually spend when it lands on this
 * branch. Callers should prefer detected source duration when
 * available and fall back here only as a placeholder.
 */
export const SIMPLIFIED_DEFAULT_DURATION_SECONDS = 30;

/**
 * Clamp the variant-count input. Non-numeric / negative / fractional
 * values land back at the default — the picker is a small integer
 * stepper, so anything outside [1, 10] is almost certainly a typo
 * pasted into the field rather than an intentional override.
 */
export function clampVariantCount(raw: number): number {
  if (!Number.isFinite(raw)) return SIMPLIFIED_DEFAULT_VARIANTS;
  const rounded = Math.round(raw);
  if (rounded < SIMPLIFIED_MIN_VARIANTS) return SIMPLIFIED_MIN_VARIANTS;
  if (rounded > SIMPLIFIED_MAX_VARIANTS) return SIMPLIFIED_MAX_VARIANTS;
  return rounded;
}

/**
 * Polish-20: model-tier accent for the "Recommended" card. Returns
 * true only for the middle-tier model so the picker can render a
 * subtle border / badge without hardcoding the specific model id.
 * A future model-set reshuffle only needs the qualityTier field
 * updated on the descriptor.
 */
export function isRecommendedTier(modelId: VideoModelId): boolean {
  const m = getVideoModel(modelId);
  return m?.qualityTier === 'recommended';
}

/**
 * Polish-23 Commit 3.5: Polish-23 pipeline picker anchors. When the
 * form's polish23Selected flag is true, the picker bypasses the
 * VideoModel descriptor system entirely and routes through the
 * PipelineType layer instead (pickedPipeline column on the job row →
 * analyze-concept dispatch → generation/polish23-veo-lite.requested).
 */
export const POLISH23_PIPELINE_ID = 'polish23_higgsfield_veo_lite' as const;
// Polish-25.7 Commit 40: internal-terminology jargon sweep. Value stripped
// of "Polish-23" so any surface that imports this const (none today, but
// keeping the export stable) renders a user-friendly name. Character
// consistency is the operator-facing feature name for the Higgsfield
// Soul + Veo Lite pipeline.
export const POLISH23_DISPLAY_NAME = 'Cinematic UGC (character consistency)';
export const POLISH23_DESCRIPTION =
  'Higgsfield Soul reference PNG threaded into a Veo 3.1 Lite 8-clip chain. ' +
  'Best character consistency at ~$1.65 per 60s ad. Recommended default.';

/**
 * Polish-25 Commit 2: pre-cast avatar pipeline picker anchors.
 * Character consistency guaranteed at platform level (same actor
 * every clip). Single video output. Recommended primary.
 *
 * Polish-25.2 Commit 11: rebranded to "Instant UGC" in the UI. The
 * pipeline ID + underlying worker names stay `polish25_makeugc`
 * for forensic + metadata continuity — only the user-facing display
 * string changed. Video generation is now platform-managed
 * (operator-run MakeUGC subscription pool); users no longer paste
 * a MakeUGC API key.
 */
export const POLISH25_PIPELINE_ID = 'polish25_makeugc' as const;
export const POLISH25_DISPLAY_NAME = 'Instant UGC ad';
export const POLISH25_DESCRIPTION =
  'Pre-cast avatar picked to match your source persona. Character consistency ' +
  'guaranteed. Fastest option, included on the platform. You only pay Claude ' +
  '+ Gemini token usage.';

/**
 * Polish-26 Commit 61 + Polish-26.0.5 Commit 61.5: HeyGen v3 is the
 * NEW primary Instant UGC backend. Commit 61 introduced the worker /
 * client / avatar-sync / cost estimator but deferred the user-facing
 * form wiring — this commit rebinds the "Instant UGC ad" card from
 * the polish25_makeugc dispatch to polish26_heygen.
 *
 * Display name stays "Instant UGC ad" (user copy doesn't change);
 * only the underlying backend + cost math flip. polish25_makeugc
 * remains callable via POST /api/v1/generations with
 * `{"pipeline": "polish25_makeugc"}` for admin / legacy testing —
 * the descriptor + worker + refresh cron are all still registered.
 */
export const POLISH26_PIPELINE_ID = 'polish26_heygen' as const;

/**
 * Polish-28.0.0 Commit 64: BYOK cloned-UGC pipeline. Character
 * clone via Nano Banana Pro + voice clone via ElevenLabs IVC +
 * lip-sync via HeyGen Avatar IV. Requires 4 BYOK keys — display
 * name kept short ("Instant UGC (Cloned)").
 */
export const POLISH28_PIPELINE_ID = 'polish28_clone_ugc' as const;
export const POLISH28_DISPLAY_NAME = 'Instant UGC (Cloned)';
export const POLISH28_DESCRIPTION =
  'Clones the exact character + voice from your source ad. One video, same person as the source. ' +
  'BYOK: Claude + Gemini + HeyGen + Replicate.';
/** Per-30s BYOK cost from Phase 1 investigation + Commit-64.5 Replicate add-on. */
export function estimatePolish28CostPerVariantUsd(): { usd: number } {
  // Claude 0.02 + Gemini vision 0.05 + Nano Banana Pro 0.13 +
  // ElevenLabs TTS 0.01 + HeyGen Avatar IV 30s @ 1080p 2.00 +
  // Replicate ffmpeg (2 calls) 0.03 + storage 0.02 = 2.26.
  return { usd: 2.26 };
}

// Polish-28.3.0 Commit 86: variations pipeline picker.
export const POLISH28_VARIATIONS_PIPELINE_ID = 'polish28_variations_ugc' as const;
export const POLISH28_VARIATIONS_DISPLAY_NAME = 'Instant UGC (Variations)';
export const POLISH28_VARIATIONS_DESCRIPTION =
  'Generates N distinct spokespeople (different persona, voice, and script variation each) all ' +
  'pitching the same offer. Meta A/B-testing pattern. BYOK: Claude + Gemini + HeyGen.';
/** Per-variant cost — no Replicate line (no source-frame extract). */
export function estimatePolish28VariationsCostPerVariantUsd(): { usd: number } {
  // Nano Banana Pro 0.13 + HeyGen Avatar IV 30s @ 1080p 2.00 +
  // storage 0.02 + amortized Claude batch (~$0.05 / N variants) = ~2.15.
  return { usd: 2.15 };
}

/**
 * Polish-29.0.10 Commit 120: credit-backed multi-clip Seedance
 * variations picker. Feeds a winning creative → N cloned-character
 * variants matching source ad length. Video render pays in credits
 * (per-clip reserve); Claude + Gemini + Replicate BYOK cover the
 * persona+script batch, Nano Banana character PNG, and Replicate
 * ffmpeg concat respectively.
 */
export const POLISH29_VARIATIONS_PIPELINE_ID = 'polish29_seedance_variations' as const;
export const POLISH29_VARIATIONS_DISPLAY_NAME = 'Cloned UGC (credits, Seedance)';
export const POLISH29_VARIATIONS_DESCRIPTION =
  'Same variations flow as Instant UGC but the video render pays in CREDITS instead of HeyGen. ' +
  'Cheaper per-variant, no HeyGen key needed. BYOK: Claude + Gemini + Replicate.';

/**
 * Seedance model tier options for the picker. Credit cost per 8s
 * clip lands on job.metadata.model_id; the worker resolves the
 * corresponding Dreamina model string via dreaminaModelForCreditModelId.
 * Kept as a plain array so the picker can render 3 cards in order.
 */
export interface Polish29ModelTier {
  id: 'seedance-2-0-fast-ugc' | 'seedance-2-0-ugc' | 'seedance-2-5-ugc';
  displayName: string;
  creditsPerClip: number;
  usdPerClip: number;
  blurb: string;
}
export const POLISH29_MODEL_TIERS: Polish29ModelTier[] = [
  {
    id: 'seedance-2-0-fast-ugc',
    displayName: 'Seedance 2.0 Fast',
    creditsPerClip: 10,
    usdPerClip: 0.2,
    blurb: 'Cheapest, fastest. Good for iteration.',
  },
  {
    id: 'seedance-2-0-ugc',
    displayName: 'Seedance 2.0',
    creditsPerClip: 20,
    usdPerClip: 0.4,
    blurb: 'Balanced quality + cost. Recommended default.',
  },
  {
    id: 'seedance-2-5-ugc',
    displayName: 'Seedance 2.5',
    creditsPerClip: 40,
    usdPerClip: 0.8,
    blurb: 'Highest quality. Slower + more expensive.',
  },
];
export const POLISH29_DEFAULT_MODEL_ID: Polish29ModelTier['id'] = 'seedance-2-0-ugc';

/**
 * Cost preview for Polish-29 variations. Duration → clip count math
 * (8s per clip, 2-10 clip clamp, 30s default when unknown), then
 * variantCount × clipCount × per-clip credit dollar cost, plus small
 * BYOK sides (Claude batch + Nano Banana + Replicate concat).
 * Mirrors the estimator branch in packages/shared/src/cost-estimation.ts
 * so form + server land on the same number.
 */
export function estimatePolish29VariationsCostUsd(input: {
  variantCount: number;
  sourceDurationSeconds: number | null;
  modelId: Polish29ModelTier['id'];
}): { usd: number; clipCount: number; perClipUsd: number } {
  const target = input.sourceDurationSeconds ?? SIMPLIFIED_DEFAULT_DURATION_SECONDS;
  const clipCount = Math.max(2, Math.min(10, Math.round(target / 8)));
  const tier = POLISH29_MODEL_TIERS.find((t) => t.id === input.modelId) ?? POLISH29_MODEL_TIERS[1]!; // 2.0 fallback
  const CLAUDE_BATCH = 0.05;
  const NANO_BANANA = 0.13;
  const REPLICATE_CONCAT = 0.02;
  const STORAGE = 0.02;
  const usd = round4(
    CLAUDE_BATCH +
      input.variantCount * NANO_BANANA +
      input.variantCount * clipCount * tier.usdPerClip +
      input.variantCount * REPLICATE_CONCAT +
      input.variantCount * STORAGE,
  );
  return { usd, clipCount, perClipUsd: tier.usdPerClip };
}
export const POLISH26_DISPLAY_NAME = 'Instant UGC ad';
export const POLISH26_DESCRIPTION =
  'Pre-cast avatar picked from a 500+ HeyGen library to match your source persona. ' +
  'Character consistency guaranteed. Standard tier at HeyGen retail ($0.50/min = ' +
  '$0.25 per 30-second video) — verified against the first live invoice. Requires ' +
  'Claude + Gemini for the script + persona-matching analysis.';

/**
 * Polish-25.3 Commit 18b: static-ad pipeline metadata. Backs the
 * "Static ad" picker card + submission FormData routing. Pipeline
 * ID matches the descriptor at packages/shared/src/pipeline-
 * descriptors.ts so the analyze-concept dispatch resolves cleanly.
 */
export const STATIC_OPENAI_PIPELINE_ID = 'static_openai_image' as const;
export const STATIC_OPENAI_DISPLAY_NAME = 'Static ad';
export const STATIC_OPENAI_DESCRIPTION =
  'Upload a winning static ad; Claude rewrites the overlay copy and OpenAI ' +
  'gpt-image-2 edits the image for each variant. Quality tier (low / medium ' +
  '/ high) drives per-image cost.';

export type StaticOpenaiQuality = 'low' | 'medium' | 'high';
export const STATIC_OPENAI_DEFAULT_QUALITY: StaticOpenaiQuality = 'medium';

/**
 * Per-quality cost preview. Values mirror the shared cost estimator
 * (packages/shared/src/cost-estimation.ts PRICING.openaiStaticImage*)
 * so a change in either file must land alongside the other.
 * Cost line = variantCount × (Claude copy $0.02 + OpenAI image per
 * quality). Kept as a small local helper because the form doesn't
 * need the full estimator machinery — just the total number.
 */
export function estimateStaticOpenaiCostPerVariantUsd(quality: StaticOpenaiQuality): {
  usd: number;
} {
  // 18b-hotfix: verified July 2026 gpt-image-2 pricing at 1024x1024.
  // Mirrors PRICING.openaiStaticImage{High,Medium,Low}Usd in
  // packages/shared/src/cost-estimation.ts — any change here MUST
  // land alongside the shared constants in one commit.
  const OPENAI_CLAUDE_USD = 0.02;
  const OPENAI_IMAGE_USD = quality === 'high' ? 0.211 : quality === 'low' ? 0.006 : 0.053;
  return { usd: round4(OPENAI_CLAUDE_USD + OPENAI_IMAGE_USD) };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Polish-20.0.1: form state shape. Model picker is REQUIRED (per spec
 * user MUST pick), represented as `modelId | null`. Generate button
 * stays disabled until non-null. `providerId` defaults to the model's
 * cheapest live provider (kie.ai at Polish-20 launch).
 *
 * Polish-23 Commit 3.5: added `polish23Selected` as an alternative
 * "picked" signal. When true, modelId is cleared and the form
 * routes through the pipeline-descriptor path instead of the video-
 * model path. Both cannot be selected simultaneously — the picker
 * clears whichever wasn't just chosen.
 *
 * NO duration field — the simplified form is duration-less; the
 * worker's Polish-19.3.1 resolveAutoVideoDuration fallback chain
 * picks the target from analyze-concept output OR the client-detected
 * source duration threaded through buildSubmissionFormData.
 */
export interface SimplifiedFormState {
  modelId: VideoModelId | null;
  providerId: VideoProviderId | null;
  variantCount: number;
  polish23Selected?: boolean;
  /**
   * Polish-25 Commit 2: MakeUGC pre-cast avatar pipeline flag.
   * Mirrors polish23Selected. When true, modelId is cleared and
   * the form routes through the polish25_makeugc descriptor →
   * generation/polish25-makeugc.requested worker event.
   */
  polish25Selected?: boolean;
  /**
   * Polish-26.0.5 Commit 61.5: HeyGen v3 pre-cast avatar picker.
   * Same "Instant UGC ad" surface as polish25Selected but routes to
   * generation/polish26-heygen.requested (the Polish-26 successor
   * worker). Mutually exclusive with the other flags. From
   * Commit 61.5 onward this is what the user-facing form dispatches
   * when the "Instant UGC ad" card is picked; polish25Selected
   * stays in the type + form data schema for API callers that pass
   * `pipeline=polish25_makeugc` explicitly.
   */
  polish26Selected?: boolean;
  /**
   * Polish-28.0.0 Commit 64: cloned-UGC pipeline flag. Routes to
   * generation/polish28-clone-ugc.requested. Mutually exclusive
   * with the other pipeline flags.
   */
  polish28Selected?: boolean;
  /**
   * Polish-28.3.0 Commit 86: variations pipeline flag. Routes to
   * generation/polish28-variations-ugc.requested. Sibling of
   * polish28Selected — mutually exclusive with clone mode + all
   * other pipeline flags.
   */
  polish28VariationsSelected?: boolean;
  /**
   * Polish-29.0.10 Commit 120: credit-backed multi-clip Seedance
   * variations flag. Routes to generation/polish29-seedance-variations
   * .requested. Mutually exclusive with all other pipeline flags.
   * Companion field `polish29ModelId` picks the Seedance credit tier.
   */
  polish29VariationsSelected?: boolean;
  polish29ModelId?: Polish29ModelTier['id'];
  /**
   * Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad flag.
   * Mutually exclusive with polish23Selected / polish25Selected /
   * polish26Selected / modelId. Companion field `staticOpenaiQuality`
   * selects the per-image cost tier when this is true.
   */
  staticOpenaiSelected?: boolean;
  staticOpenaiQuality?: StaticOpenaiQuality;
  /**
   * Polish-28.3.12 Commit 97: visual-variation intensity for the
   * static-ad edit. Persisted onto the job row's `intensity` column
   * (previously hardcoded to 'medium'). Consumed by
   * generate-static-openai-image-variants.ts to calibrate the per-
   * intensity visual-change bullets in the /v1/images/edits prompt.
   * Only surfaced when staticOpenaiSelected is true.
   */
  staticOpenaiIntensity?: 'small' | 'medium' | 'big';
}

/**
 * Polish-20.0.1: is the state complete enough to submit? Blocks
 * Generate until the model picker has a value. Duration is no longer
 * required from the form — the worker resolves it server-side.
 */
export function canSubmitState(state: SimplifiedFormState): boolean {
  // Polish-23 / Polish-25 / Polish-26: pipeline-selected flags are
  // alternative "picked" signals that bypass the modelId requirement.
  // Any one of {modelId, polish23Selected, polish25Selected,
  // polish26Selected, staticOpenaiSelected} satisfies the gate.
  const hasPickedPipeline =
    state.polish23Selected === true ||
    state.polish25Selected === true ||
    state.polish26Selected === true ||
    state.polish28Selected === true ||
    state.polish28VariationsSelected === true ||
    state.polish29VariationsSelected === true ||
    state.staticOpenaiSelected === true;
  if (!hasPickedPipeline && state.modelId == null) return false;
  if (!Number.isInteger(state.variantCount) || state.variantCount < SIMPLIFIED_MIN_VARIANTS) {
    return false;
  }
  return true;
}

/**
 * Polish-21: when the launcher only surfaces a single model the
 * picker collapses to an auto-selected default. Callers use this to
 * decide whether to render the 3-card model picker or just show a
 * "Model: {name}" line. When the launcher grows a second visible
 * model (Polish-22 HeyGen candidate) the picker reappears
 * automatically.
 */
export function getSoleLauncherModel(
  models: readonly VideoModel[] = LAUNCHER_VISIBLE_MODELS,
): VideoModel | null {
  return models.length === 1 ? (models[0] ?? null) : null;
}

/**
 * Build the FormData payload the simplified form submits.
 *
 * Polish-20.0.1 shape:
 *   - conceptId, variantCount
 *   - modelId + providerId — the canonical routing signals
 *   - sourceDurationSeconds — ONLY when the caller passes a client-
 *     detected value (analyze-concept + fallback chain also produce
 *     one server-side; the FormData channel just seeds it when
 *     detection ran early)
 *   - intensity=medium + mode=live still hardcoded because the
 *     action handler validates them, but the values are constants
 *     the simplified form never surfaces
 */
export function buildSubmissionFormData(input: {
  conceptId: string;
  state: SimplifiedFormState;
  /**
   * Optional client-detected source duration (from
   * apps/web/app/concepts/[id]/generate/detect-video-duration.ts).
   * Persisted to job.metadata.source_duration_seconds so the
   * worker's Polish-19.3.1 fallback chain lands on it when
   * analyze-concept hasn't emitted a vision-derived value yet.
   * Omitted when unknown; the worker falls back to 30s default.
   */
  detectedSourceSeconds?: number | null;
}): FormData {
  const fd = new FormData();
  fd.set('conceptId', input.conceptId);
  fd.set('intensity', 'medium');
  fd.set('mode', 'live');
  fd.set('variantCount', String(input.state.variantCount));
  if (
    input.detectedSourceSeconds != null &&
    Number.isFinite(input.detectedSourceSeconds) &&
    input.detectedSourceSeconds > 0
  ) {
    fd.set('sourceDurationSeconds', String(Math.round(input.detectedSourceSeconds)));
  }
  // Polish-23 Commit 3.5: when the operator selects the Polish-23
  // card, we set `pipeline` instead of `modelId`. The action's
  // pipelineFromString('polish23_higgsfield_veo_lite') resolves to
  // the descriptor; analyze-concept's dispatch chain routes via the
  // descriptor's workerEvent (generation/polish23-veo-lite.requested)
  // because no metadata.model_id is set. Cleaner than adding
  // polish23 as a synthetic VideoModelId, which would tangle two
  // descriptor systems.
  if (input.state.polish29VariationsSelected === true) {
    // Polish-29.0.10 Commit 120: credit-backed Seedance variations.
    // Threads the picked model tier through job.metadata.model_id so
    // the worker resolves it via the standard metaModelId fallback
    // (no bespoke event.data field). aspect_ratio hardcoded 9:16 for
    // now — most UGC ads are vertical.
    fd.set('pipeline', POLISH29_VARIATIONS_PIPELINE_ID);
    fd.set('polish29ModelId', input.state.polish29ModelId ?? POLISH29_DEFAULT_MODEL_ID);
    return fd;
  }
  if (input.state.polish28VariationsSelected === true) {
    // Polish-28.3.0 Commit 86: variations pipeline. Checked BEFORE
    // clone branch — if both flags are set (shouldn't happen with
    // the mutually-exclusive picker UI), variations wins.
    fd.set('pipeline', POLISH28_VARIATIONS_PIPELINE_ID);
    return fd;
  }
  if (input.state.polish28Selected === true) {
    // Polish-28.0.0 Commit 64: cloned-UGC pipeline dispatches
    // pipeline=polish28_clone_ugc.
    fd.set('pipeline', POLISH28_PIPELINE_ID);
    return fd;
  }
  if (input.state.polish26Selected === true) {
    // Polish-26.0.5 Commit 61.5: HeyGen v3 pre-cast avatar. Routes
    // via the polish26_heygen descriptor's workerEvent
    // (generation/polish26-heygen.requested). Note: worker
    // unregistered post-Commit-63, so this branch is API-callable
    // but the /api/v1/generations endpoint will reject it with 400.
    fd.set('pipeline', POLISH26_PIPELINE_ID);
    return fd;
  }
  if (input.state.polish25Selected === true) {
    // Polish-25 Commit 2: MakeUGC pre-cast avatar. Kept for API
    // callers that pass `pipeline=polish25_makeugc` explicitly.
    // The user-facing form dispatches polish26Selected above from
    // Commit 61.5 onward.
    fd.set('pipeline', POLISH25_PIPELINE_ID);
    return fd;
  }
  if (input.state.staticOpenaiSelected === true) {
    // Polish-25.3 Commit 18b: static ad routing. Descriptor routes
    // to generation/static-openai.requested. Quality tier lands in
    // job.metadata.static_openai_quality (see actions.ts).
    fd.set('pipeline', STATIC_OPENAI_PIPELINE_ID);
    fd.set('staticOpenaiQuality', input.state.staticOpenaiQuality ?? STATIC_OPENAI_DEFAULT_QUALITY);
    // Polish-28.3.12 Commit 97: user-selectable intensity for the
    // per-variant visual variation. Overrides the default 'medium'
    // set at the top of this function.
    if (input.state.staticOpenaiIntensity) {
      fd.set('intensity', input.state.staticOpenaiIntensity);
    }
    return fd;
  }
  if (input.state.polish23Selected === true) {
    fd.set('pipeline', POLISH23_PIPELINE_ID);
    return fd;
  }
  if (input.state.modelId) fd.set('modelId', input.state.modelId);
  if (input.state.providerId) fd.set('providerId', input.state.providerId);
  return fd;
}

/**
 * Polish-23 Commit 3.5: cost preview for the Polish-23 pipeline card.
 * Wraps estimateGenerationCost with the polish23 descriptor branch
 * so the form's cost line can render inline without importing the
 * shared estimator directly. Ceiling anchor: 60s = $1.84 per BCH's
 * validated math (Higgsfield Soul $0.23 + 8 × Veo Lite $0.175 +
 * Claude $0.02 + Nano Banana seed $0.04 + Replicate concat $0.15).
 */
export interface Polish23CostEstimate {
  usd: number;
}
export function estimatePolish23CostPerVariantUsd(
  sourceDurationSeconds: number | null,
): Polish23CostEstimate {
  // Anchored to BCH's cost math without importing the shared
  // estimator (keeps the form's client bundle small). Duration
  // doesn't currently affect the polish23 line because segment
  // count is fixed at 8 for Commit 3; a Polish-24+ variable-N
  // pipeline would thread duration through here.
  void sourceDurationSeconds;
  const SOUL = 0.23;
  const VEO_LITE_PER_CLIP = 0.175;
  const CLAUDE = 0.02;
  const NANO_BANANA_SEED = 0.04;
  const REPLICATE_CONCAT = 0.15;
  const CLIP_COUNT = 8;
  return {
    usd: SOUL + CLIP_COUNT * VEO_LITE_PER_CLIP + CLAUDE + NANO_BANANA_SEED + REPLICATE_CONCAT,
  };
}

/**
 * Polish-25 Commit 2: cost preview for the MakeUGC pipeline card.
 * Real anchor: 1 MakeUGC credit + tiny Claude condenser call.
 *   Claude condenser  $0.02
 *   MakeUGC video     $0.0495 ($99 / 2000 credits, Starter tier)
 *   ----------------- ------
 *   Total per variant $0.0695
 *
 * Duration doesn't scale the line — MakeUGC bills per video, not
 * per second. Multi-variant scales linearly.
 */
export interface Polish25CostEstimate {
  usd: number;
}
export function estimatePolish25CostPerVariantUsd(): Polish25CostEstimate {
  const CLAUDE = 0.02;
  const MAKEUGC = 99 / 2000;
  return { usd: CLAUDE + MAKEUGC };
}

/**
 * Polish-26.0.5 Commit 61.5: cost preview for the HeyGen Instant
 * UGC pipeline card. Real anchor: Claude condenser + HeyGen v3
 * standard-tier retail rate ($0.50/min = $0.00833/sec, see
 * packages/ai-providers/src/heygen-v3-client.ts's LARGE COMMENT
 * for the true-up plan against the first invoice).
 *
 * Duration DOES scale the line — HeyGen bills per second (unlike
 * MakeUGC which bills per finished video). A 30-sec hook is $0.25;
 * a 60-sec hook is $0.50; the operator picks a longer source and
 * the preview reflects that immediately.
 *
 * Duplicated constants (rather than imported from @mbb/ai-providers)
 * because this file ships in the client bundle — importing the
 * whole ai-providers package would balloon it. Values must stay in
 * lockstep with HEYGEN_USD_PER_SECOND_STANDARD in the client.
 */
export interface Polish26CostEstimate {
  usd: number;
}
export function estimatePolish26CostPerVariantUsd(
  sourceDurationSeconds: number | null,
): Polish26CostEstimate {
  const CLAUDE = 0.02;
  const HEYGEN_USD_PER_SECOND_STANDARD = 0.5 / 60; // $0.00833/sec
  const seconds =
    typeof sourceDurationSeconds === 'number' && sourceDurationSeconds > 0
      ? sourceDurationSeconds
      : SIMPLIFIED_DEFAULT_DURATION_SECONDS;
  return { usd: round4(CLAUDE + HEYGEN_USD_PER_SECOND_STANDARD * seconds) };
}
