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
export const POLISH23_DISPLAY_NAME = 'Polish-23 UGC (Higgsfield Soul + Veo Lite)';
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
  'guaranteed. Fastest option — included on the platform, you only pay Claude ' +
  '+ Gemini token usage.';

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
}

/**
 * Polish-20.0.1: is the state complete enough to submit? Blocks
 * Generate until the model picker has a value. Duration is no longer
 * required from the form — the worker resolves it server-side.
 */
export function canSubmitState(state: SimplifiedFormState): boolean {
  // Polish-23 / Polish-25: pipeline-selected flags are alternative
  // "picked" signals that bypass the modelId requirement. Any one of
  // {modelId, polish23Selected, polish25Selected} satisfies the gate.
  const hasPickedPipeline = state.polish23Selected === true || state.polish25Selected === true;
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
  if (input.state.polish25Selected === true) {
    // Polish-25 Commit 2: MakeUGC pre-cast avatar. Routes via the
    // polish25_makeugc descriptor's workerEvent
    // (generation/polish25-makeugc.requested). Same pattern as
    // polish23Selected — set `pipeline` instead of modelId.
    fd.set('pipeline', POLISH25_PIPELINE_ID);
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
