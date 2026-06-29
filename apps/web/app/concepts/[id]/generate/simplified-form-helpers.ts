/**
 * Polish-19 Commit 3: pure helpers for the simplified generation form.
 *
 * Extracted so the form's submission logic + defaults + clamps can be
 * tested without spinning up React / jsdom (same pattern Polish-12 used
 * for the kie-omni worker decision helpers).
 */
import type { PipelineType } from '@mbb/shared';

/** Variant-count picker bounds. Min 1, max enforced server-side. */
export const SIMPLIFIED_MIN_VARIANTS = 1;
export const SIMPLIFIED_MAX_VARIANTS = 10;
export const SIMPLIFIED_DEFAULT_VARIANTS = 5;

/** Length picker bounds (seconds). Matches worker's MIN/MAX target. */
export const SIMPLIFIED_MIN_LENGTH_SECONDS = 8;
export const SIMPLIFIED_MAX_LENGTH_SECONDS = 300;
export const SIMPLIFIED_DEFAULT_LENGTH_SECONDS = 30;

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
 * Clamp the length input. Same bounds as the kie-kling-avatar worker's
 * resolveTargetDuration so the cost preview matches what the worker
 * will produce. Defaults to 30s on garbage input.
 */
export function clampLengthSeconds(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return SIMPLIFIED_DEFAULT_LENGTH_SECONDS;
  const ceiled = Math.ceil(raw);
  if (ceiled < SIMPLIFIED_MIN_LENGTH_SECONDS) return SIMPLIFIED_MIN_LENGTH_SECONDS;
  if (ceiled > SIMPLIFIED_MAX_LENGTH_SECONDS) return SIMPLIFIED_MAX_LENGTH_SECONDS;
  return ceiled;
}

export interface SimplifiedFormState {
  pipeline: PipelineType;
  voiceId: string;
  variantCount: number;
  lengthSeconds: number;
}

/**
 * Build the FormData payload the simplified form submits.
 * Matches the existing createGenerationJobAction FormData shape:
 *   - conceptId, pipeline, variantCount, sourceDurationSeconds (legacy
 *     name; conceptually IS the target duration the worker uses), voiceId
 *   - intensity hardcoded to 'medium' since the simplified form doesn't
 *     expose the picker (Advanced form keeps it).
 *   - mode hardcoded to 'live' (Polish-3 retired the mock toggle).
 */
export function buildSubmissionFormData(input: {
  conceptId: string;
  state: SimplifiedFormState;
}): FormData {
  const fd = new FormData();
  fd.set('conceptId', input.conceptId);
  fd.set('intensity', 'medium');
  fd.set('mode', 'live');
  fd.set('pipeline', input.state.pipeline);
  fd.set('voiceId', input.state.voiceId);
  fd.set('variantCount', String(input.state.variantCount));
  fd.set('sourceDurationSeconds', String(input.state.lengthSeconds));
  return fd;
}
