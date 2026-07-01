/**
 * Polish-19 Commit 3 → Polish-20.0.1: pure-helper tests for the
 * simplified generation form. React/jsdom-free — just clamp helpers +
 * FormData submission shape. Duration picker removed in 20.0.1;
 * source duration flows through as an optional FormData field
 * threaded from client-side detection.
 */
import { describe, expect, it } from 'vitest';
import {
  SIMPLIFIED_DEFAULT_DURATION_SECONDS,
  SIMPLIFIED_DEFAULT_VARIANTS,
  SIMPLIFIED_MAX_VARIANTS,
  SIMPLIFIED_MIN_VARIANTS,
  buildSubmissionFormData,
  canSubmitState,
  clampVariantCount,
  isRecommendedTier,
} from '../simplified-form-helpers';

describe('Polish-20: clampVariantCount', () => {
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

describe('Polish-20.0.1: canSubmitState — Generate button gate', () => {
  const base = {
    modelId: 'kling_3_standard' as const,
    providerId: 'kie_ai' as const,
    variantCount: 5,
  };

  it('accepts a complete state (model picked, count valid) — no duration required', () => {
    expect(canSubmitState(base)).toBe(true);
  });

  it('BLOCKS submission when modelId is null (spec: user MUST pick)', () => {
    expect(canSubmitState({ ...base, modelId: null })).toBe(false);
  });

  it('BLOCKS when variantCount is below MIN or non-integer', () => {
    expect(canSubmitState({ ...base, variantCount: 0 })).toBe(false);
    expect(canSubmitState({ ...base, variantCount: 3.5 })).toBe(false);
    expect(canSubmitState({ ...base, variantCount: NaN })).toBe(false);
  });

  it('allows submission even when providerId is null (form auto-picks default)', () => {
    // Provider is optional in the state — the form auto-fills it from
    // the model's default provider descriptor. The action-handler
    // side is what actually needs a resolved provider.
    expect(canSubmitState({ ...base, providerId: null })).toBe(true);
  });
});

describe('Polish-20: isRecommendedTier — accent flag for the middle card', () => {
  it('true only for the Kling 3.0 Standard recommended tier', () => {
    expect(isRecommendedTier('kling_3_standard')).toBe(true);
  });

  it('false for the budget + premium tiers', () => {
    expect(isRecommendedTier('seedance_1_5_pro')).toBe(false);
    expect(isRecommendedTier('seedance_2')).toBe(false);
  });
});

describe('Polish-20.0.1: buildSubmissionFormData clean shape', () => {
  it('emits ONLY the descriptor-driven fields the action handler reads (no duration state)', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'concept_abc',
      state: {
        modelId: 'kling_3_standard',
        providerId: 'kie_ai',
        variantCount: 5,
      },
      detectedSourceSeconds: 30,
    });
    expect(fd.get('conceptId')).toBe('concept_abc');
    expect(fd.get('intensity')).toBe('medium');
    expect(fd.get('mode')).toBe('live');
    expect(fd.get('variantCount')).toBe('5');
    expect(fd.get('modelId')).toBe('kling_3_standard');
    expect(fd.get('providerId')).toBe('kie_ai');
    // Legacy fields must NOT appear.
    expect(fd.has('pipeline')).toBe(false);
    expect(fd.has('voiceId')).toBe(false);
  });

  it('OMITS modelId + providerId when the state fields are null (defense-in-depth)', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      state: {
        modelId: null,
        providerId: null,
        variantCount: 1,
      },
    });
    expect(fd.has('modelId')).toBe(false);
    expect(fd.has('providerId')).toBe(false);
  });

  it('sends sourceDurationSeconds when detectedSourceSeconds is a positive finite number', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      state: {
        modelId: 'seedance_1_5_pro',
        providerId: 'kie_ai',
        variantCount: 3,
      },
      detectedSourceSeconds: 15,
    });
    expect(fd.get('sourceDurationSeconds')).toBe('15');
  });

  it('rounds fractional detectedSourceSeconds so the worker clamp reads a whole number', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      state: { modelId: 'seedance_2', providerId: 'kie_ai', variantCount: 1 },
      detectedSourceSeconds: 12.7,
    });
    expect(fd.get('sourceDurationSeconds')).toBe('13');
  });

  it('OMITS sourceDurationSeconds when detectedSourceSeconds is null / undefined / non-positive / NaN', () => {
    for (const bad of [null, undefined, 0, -5, NaN, Infinity]) {
      const fd = buildSubmissionFormData({
        conceptId: 'c',
        state: { modelId: 'seedance_2', providerId: 'kie_ai', variantCount: 1 },
        detectedSourceSeconds: bad as number | null | undefined,
      });
      expect(fd.has('sourceDurationSeconds')).toBe(false);
    }
  });

  it('OMITS sourceDurationSeconds when the caller does not pass the field at all', () => {
    // Detection still pending → the worker's Polish-19.3.1 fallback
    // chain lands on analyze-concept output or the 30s default.
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      state: { modelId: 'kling_3_standard', providerId: 'kie_ai', variantCount: 1 },
    });
    expect(fd.has('sourceDurationSeconds')).toBe(false);
  });

  it('intensity + mode are always hardcoded (simplified form does not expose either)', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      state: {
        modelId: 'seedance_2',
        providerId: 'kie_ai',
        variantCount: 1,
      },
    });
    expect(fd.get('intensity')).toBe('medium');
    expect(fd.get('mode')).toBe('live');
  });
});

describe('Polish-20.0.1: SIMPLIFIED_DEFAULT_DURATION_SECONDS', () => {
  it('duration default is 30s (matches the worker resolveAutoVideoDuration fallback)', () => {
    expect(SIMPLIFIED_DEFAULT_DURATION_SECONDS).toBe(30);
  });
});

describe('Polish-20.0.1: simplified form component source tripwires', () => {
  // The form component owns the length-picker UI shape. Pin that the
  // 8s/15s/30s/60s buttons + snapToNearestDurationPreset call are
  // gone AND that the read-only "Auto-detected" indicator + advanced-
  // form link are in place. A regression that reintroduces the picker
  // would fail here before shipping.

  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(new URL('../simplified-form.tsx', import.meta.url), 'utf8');
  };

  it('length preset button block is REMOVED', async () => {
    const src = await readSrc();
    // The preset map wrote {preset}s buttons and referenced
    // VIDEO_DURATION_PRESETS + snapToNearestDurationPreset. All three
    // must be absent post-20.0.1.
    expect(src).not.toMatch(/VIDEO_DURATION_PRESETS/);
    expect(src).not.toMatch(/snapToNearestDurationPreset/);
    expect(src).not.toMatch(/aria-pressed=\{durationSeconds === preset\}/);
  });

  it('read-only "Auto-detected" indicator is present + points at the advanced form', async () => {
    const src = await readSrc();
    expect(src).toMatch(/Auto-detected/);
    expect(src).toMatch(/from source video/);
    expect(src).toMatch(/generate\/advanced/);
  });

  it('cost preview shows the "calculated after source analysis" placeholder when detection pending', async () => {
    const src = await readSrc();
    expect(src).toMatch(/Cost calculated after source analysis/);
    expect(src).toMatch(/detectionPending/);
  });

  it('durationSeconds state is GONE (no useState for it)', async () => {
    const src = await readSrc();
    expect(src).not.toMatch(/useState<number>\(\s*snapToNearestDurationPreset/);
    expect(src).not.toMatch(/setDurationSeconds/);
  });
});
