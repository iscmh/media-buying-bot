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
 * Polish-20.0.1: form state shape. Model picker is REQUIRED (per spec
 * user MUST pick), represented as `modelId | null`. Generate button
 * stays disabled until non-null. `providerId` defaults to the model's
 * cheapest live provider (kie.ai at Polish-20 launch).
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
}

/**
 * Polish-20.0.1: is the state complete enough to submit? Blocks
 * Generate until the model picker has a value. Duration is no longer
 * required from the form — the worker resolves it server-side.
 */
export function canSubmitState(state: SimplifiedFormState): boolean {
  if (state.modelId == null) return false;
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
  if (input.state.modelId) fd.set('modelId', input.state.modelId);
  if (input.state.providerId) fd.set('providerId', input.state.providerId);
  return fd;
}
