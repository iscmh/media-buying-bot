/**
 * Polish-19 Commit 3 → Polish-20 Commit 1: pure helpers for the
 * simplified generation form.
 *
 * Polish-20 shift: the form now picks a (model, provider) pair from
 * the packages/shared/src/video-models.ts descriptor layer instead
 * of a PipelineType. Legacy `pipeline` field is retained on the
 * FormData shape so the existing action handler still routes to a
 * worker during the architectural transition — Commit 2 flips
 * dispatch to the new unified worker, Commits 3-4 remove the legacy
 * pipelines entirely.
 */
import type { PipelineType } from '@mbb/shared';
import {
  computeSegmentCountForModel,
  formatModelCostHintPerVariant,
  getDefaultProviderForModel,
  getModelProviderConfig,
  getVideoModel,
  snapToNearestDurationPreset,
  VIDEO_DURATION_PRESETS,
  VIDEO_MODELS,
  type VideoModel,
  type VideoModelId,
  type VideoProviderId,
} from '@mbb/shared';

// Re-export the shared descriptor bits the form component needs so
// the component file only imports from a single module.
export {
  VIDEO_DURATION_PRESETS,
  VIDEO_MODELS,
  computeSegmentCountForModel,
  formatModelCostHintPerVariant,
  getDefaultProviderForModel,
  getModelProviderConfig,
  getVideoModel,
  snapToNearestDurationPreset,
};
export type { VideoModel, VideoModelId, VideoProviderId };

/** Variant-count picker bounds. Min 1, max enforced server-side. */
export const SIMPLIFIED_MIN_VARIANTS = 1;
export const SIMPLIFIED_MAX_VARIANTS = 10;
export const SIMPLIFIED_DEFAULT_VARIANTS = 5;

/**
 * Polish-20: default duration preset when no source has been detected
 * yet. 30s matches the most common UGC ad length and stays consistent
 * with the pre-Polish-20 form default.
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
 * Polish-20: form state shape. Model picker is REQUIRED (per spec
 * user MUST pick), represented as `modelId | null`. Generate button
 * stays disabled until non-null. `providerId` defaults to the model's
 * cheapest live provider (kie.ai at Polish-20 launch).
 */
export interface SimplifiedFormState {
  modelId: VideoModelId | null;
  providerId: VideoProviderId | null;
  variantCount: number;
  durationSeconds: number;
}

/**
 * Polish-20: is the state complete enough to submit? Blocks Generate
 * until the model picker has a value.
 */
export function canSubmitState(state: SimplifiedFormState): boolean {
  if (state.modelId == null) return false;
  if (!Number.isInteger(state.variantCount) || state.variantCount < SIMPLIFIED_MIN_VARIANTS) {
    return false;
  }
  if (!Number.isFinite(state.durationSeconds) || state.durationSeconds <= 0) return false;
  return true;
}

/**
 * Build the FormData payload the simplified form submits.
 *
 * Polish-20 Commit 1 additive shape:
 *   - Everything the existing createGenerationJobAction reads
 *     (conceptId, pipeline, variantCount, sourceDurationSeconds,
 *     intensity=medium, mode=live, voiceId).
 *   - NEW fields: modelId, providerId, sourceDurationSeconds always
 *     sent (worker's Polish-19.3.1 fallback chain honors it).
 *   - `pipeline` is set to a stable legacy value so the existing
 *     analyze-concept dispatch keeps working during Commit 1. Commit 2
 *     flips analyze-concept to route on modelId instead and this
 *     field becomes vestigial before being removed in Commit 3.
 */
export function buildSubmissionFormData(input: {
  conceptId: string;
  legacyPipeline: PipelineType;
  legacyVoiceId: string;
  state: SimplifiedFormState;
}): FormData {
  const fd = new FormData();
  fd.set('conceptId', input.conceptId);
  fd.set('intensity', 'medium');
  fd.set('mode', 'live');
  // Polish-20 Commit 1 legacy compat: keep pipeline + voiceId writes
  // so the pre-Commit 2 dispatch still routes to a working worker.
  fd.set('pipeline', input.legacyPipeline);
  fd.set('voiceId', input.legacyVoiceId);
  fd.set('variantCount', String(input.state.variantCount));
  fd.set('sourceDurationSeconds', String(input.state.durationSeconds));
  // Polish-20 NEW: descriptor-driven fields. Commit 2 makes these the
  // canonical routing signal.
  if (input.state.modelId) fd.set('modelId', input.state.modelId);
  if (input.state.providerId) fd.set('providerId', input.state.providerId);
  return fd;
}
