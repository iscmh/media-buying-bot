/**
 * Polish-19 Commit 3: pure helpers for the simplified generation form.
 *
 * Extracted so the form's submission logic + defaults + clamps can be
 * tested without spinning up React / jsdom (same pattern Polish-12 used
 * for the kie-omni worker decision helpers).
 */
import type { PipelineType } from '@mbb/shared';
import { computeVeoSegmentCount } from '@mbb/shared';

/**
 * Polish-19.3: preset durations for the Veo 3.1 Fast pipeline. Free-
 * form length entry doesn't make sense for Veo because the worker
 * chunks output into 8s segments; a 23s pick would generate ~3
 * segments (24s of output) anyway. Presets map cleanly to segment
 * counts: 8s/15s/30s/60s → 1/2/4/8 segments respectively.
 *
 * Other pipelines (Kling, Omni Flash, HeyGen) keep the free-form
 * number input — their workers don't chunk and accept arbitrary
 * durations.
 */
export interface VeoLengthPreset {
  seconds: number;
  /** Display label shown on the button. */
  label: string;
  /** Pre-computed segment count for the button's secondary hint. */
  segments: number;
}

export const VEO_LENGTH_PRESETS: VeoLengthPreset[] = [
  { seconds: 8, label: '8s', segments: computeVeoSegmentCount(8) },
  { seconds: 15, label: '15s', segments: computeVeoSegmentCount(15) },
  { seconds: 30, label: '30s', segments: computeVeoSegmentCount(30) },
  { seconds: 60, label: '60s', segments: computeVeoSegmentCount(60) },
];

/**
 * Polish-19.3: snap a free-form length to the nearest Veo preset.
 * Used when the user switches pipeline back to Veo with an existing
 * length state — e.g. switching from Kling (30s) → Veo, the value
 * snaps to the 30s preset rather than landing on a non-preset value.
 */
export function snapToVeoPreset(seconds: number): VeoLengthPreset {
  if (!Number.isFinite(seconds) || seconds <= 0) return VEO_LENGTH_PRESETS[0]!;
  // Find the closest preset by absolute distance.
  let closest = VEO_LENGTH_PRESETS[0]!;
  let closestDelta = Math.abs(closest.seconds - seconds);
  for (const p of VEO_LENGTH_PRESETS) {
    const d = Math.abs(p.seconds - seconds);
    if (d < closestDelta) {
      closest = p;
      closestDelta = d;
    }
  }
  return closest;
}

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
