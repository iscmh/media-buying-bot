/**
 * Polish-19 Commit 3: pure-helper tests for the simplified generation
 * form. Mirrors the Polish-12 pattern — react/jsdom-free, just clamp +
 * submission-payload logic.
 */
import { describe, expect, it } from 'vitest';
import { defaultPipeline } from '@mbb/shared';
import {
  SIMPLIFIED_DEFAULT_LENGTH_SECONDS,
  SIMPLIFIED_DEFAULT_VARIANTS,
  SIMPLIFIED_MAX_LENGTH_SECONDS,
  SIMPLIFIED_MAX_VARIANTS,
  SIMPLIFIED_MIN_LENGTH_SECONDS,
  SIMPLIFIED_MIN_VARIANTS,
  VEO_LENGTH_PRESETS,
  buildSubmissionFormData,
  clampLengthSeconds,
  clampVariantCount,
  snapToVeoPreset,
} from '../simplified-form-helpers';

describe('Polish-19: clampVariantCount', () => {
  it('passes through canonical mid-range values', () => {
    expect(clampVariantCount(1)).toBe(1);
    expect(clampVariantCount(5)).toBe(5);
    expect(clampVariantCount(10)).toBe(10);
  });

  it('rounds fractional values', () => {
    expect(clampVariantCount(4.3)).toBe(4);
    expect(clampVariantCount(4.7)).toBe(5);
  });

  it('clamps below MIN to MIN', () => {
    expect(clampVariantCount(0)).toBe(SIMPLIFIED_MIN_VARIANTS);
    expect(clampVariantCount(-3)).toBe(SIMPLIFIED_MIN_VARIANTS);
  });

  it('clamps above MAX to MAX', () => {
    expect(clampVariantCount(11)).toBe(SIMPLIFIED_MAX_VARIANTS);
    expect(clampVariantCount(9999)).toBe(SIMPLIFIED_MAX_VARIANTS);
  });

  it('returns default on non-finite values (typo in field, etc.)', () => {
    expect(clampVariantCount(NaN)).toBe(SIMPLIFIED_DEFAULT_VARIANTS);
    expect(clampVariantCount(Infinity)).toBe(SIMPLIFIED_DEFAULT_VARIANTS);
  });
});

describe('Polish-19: clampLengthSeconds', () => {
  it('passes through canonical mid-range values', () => {
    expect(clampLengthSeconds(30)).toBe(30);
    expect(clampLengthSeconds(60)).toBe(60);
    expect(clampLengthSeconds(120)).toBe(120);
  });

  it('ceils fractional values so the worker never under-generates', () => {
    expect(clampLengthSeconds(29.1)).toBe(30);
    expect(clampLengthSeconds(30.9)).toBe(31);
  });

  it('clamps below MIN to MIN', () => {
    expect(clampLengthSeconds(3)).toBe(SIMPLIFIED_MIN_LENGTH_SECONDS);
    expect(clampLengthSeconds(1)).toBe(SIMPLIFIED_MIN_LENGTH_SECONDS);
  });

  it('clamps above MAX (5-minute kie.ai ceiling) to MAX', () => {
    expect(clampLengthSeconds(600)).toBe(SIMPLIFIED_MAX_LENGTH_SECONDS);
    expect(clampLengthSeconds(99999)).toBe(SIMPLIFIED_MAX_LENGTH_SECONDS);
  });

  it('returns default on garbage input', () => {
    expect(clampLengthSeconds(0)).toBe(SIMPLIFIED_DEFAULT_LENGTH_SECONDS);
    expect(clampLengthSeconds(-10)).toBe(SIMPLIFIED_DEFAULT_LENGTH_SECONDS);
    expect(clampLengthSeconds(NaN)).toBe(SIMPLIFIED_DEFAULT_LENGTH_SECONDS);
  });
});

describe('Polish-19: buildSubmissionFormData', () => {
  it('emits the FormData keys the existing createGenerationJobAction handler reads', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'concept_abc',
      state: {
        pipeline: defaultPipeline(),
        voiceId: '21m00Tcm4TlvDq8ikWAM',
        variantCount: 5,
        lengthSeconds: 30,
      },
    });
    // Existing handler reads exactly these keys; the simplified form
    // must match the names verbatim or the action will reject the
    // submission with "Pick an intensity" / similar.
    expect(fd.get('conceptId')).toBe('concept_abc');
    expect(fd.get('intensity')).toBe('medium'); // hardcoded; not user-facing
    expect(fd.get('mode')).toBe('live');
    expect(fd.get('pipeline')).toBe(defaultPipeline());
    expect(fd.get('voiceId')).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(fd.get('variantCount')).toBe('5');
    // Polish-14.1 legacy name — semantically IS the target duration.
    // See actions.ts for the rationale on not renaming.
    expect(fd.get('sourceDurationSeconds')).toBe('30');
  });

  it('always sets intensity=medium (simplified form hides the picker)', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      state: {
        pipeline: defaultPipeline(),
        voiceId: 'v',
        variantCount: 1,
        lengthSeconds: 8,
      },
    });
    expect(fd.get('intensity')).toBe('medium');
  });

  it('emits the current defaultPipeline() — flips automatically if the canonical default changes', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      state: {
        pipeline: defaultPipeline(),
        voiceId: 'v',
        variantCount: 5,
        lengthSeconds: 30,
      },
    });
    // After Polish-19 Commit 1 this is kie_kling_avatar_v2_standard.
    // A future flip changes both this assertion AND defaultPipeline()
    // simultaneously — the test acts as a tripwire.
    expect(fd.get('pipeline')).toBe(defaultPipeline());
  });
});

describe('Polish-19.3: VEO_LENGTH_PRESETS', () => {
  it('ships exactly four presets covering 8s/15s/30s/60s', () => {
    expect(VEO_LENGTH_PRESETS.map((p) => p.seconds)).toEqual([8, 15, 30, 60]);
  });

  it('each preset has a label and a pre-computed segment count', () => {
    for (const p of VEO_LENGTH_PRESETS) {
      expect(p.label).toMatch(/s$/);
      expect(p.segments).toBeGreaterThan(0);
    }
  });

  it('segment counts match computeVeoSegmentCount: 1/2/4/8', () => {
    const segments = VEO_LENGTH_PRESETS.map((p) => p.segments);
    expect(segments).toEqual([1, 2, 4, 8]);
  });
});

describe('Polish-19.3: snapToVeoPreset', () => {
  it('returns the exact preset when the input matches a preset value', () => {
    expect(snapToVeoPreset(8).seconds).toBe(8);
    expect(snapToVeoPreset(15).seconds).toBe(15);
    expect(snapToVeoPreset(30).seconds).toBe(30);
    expect(snapToVeoPreset(60).seconds).toBe(60);
  });

  it('snaps to the closest preset for between-preset values', () => {
    // closer to 15 than 30
    expect(snapToVeoPreset(20).seconds).toBe(15);
    // closer to 30 than 15 (delta: 30-23=7 vs 23-15=8)
    expect(snapToVeoPreset(23).seconds).toBe(30);
    // closer to 30 than 60
    expect(snapToVeoPreset(40).seconds).toBe(30);
    // closer to 60 than 30
    expect(snapToVeoPreset(50).seconds).toBe(60);
  });

  it('clamps below-floor values to the smallest preset (8s)', () => {
    expect(snapToVeoPreset(0).seconds).toBe(8);
    expect(snapToVeoPreset(-5).seconds).toBe(8);
    expect(snapToVeoPreset(NaN).seconds).toBe(8);
  });

  it('snaps above-ceiling values to the largest preset (60s)', () => {
    expect(snapToVeoPreset(120).seconds).toBe(60);
    expect(snapToVeoPreset(9999).seconds).toBe(60);
  });
});
