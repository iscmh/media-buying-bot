/**
 * Polish-19 Commit 3 → Polish-20 Commit 1: pure-helper tests for the
 * simplified generation form. React/jsdom-free — just clamp helpers +
 * FormData submission shape.
 */
import { describe, expect, it } from 'vitest';
import { defaultPipeline } from '@mbb/shared';
import {
  SIMPLIFIED_DEFAULT_DURATION_SECONDS,
  SIMPLIFIED_DEFAULT_VARIANTS,
  SIMPLIFIED_MAX_VARIANTS,
  SIMPLIFIED_MIN_VARIANTS,
  VIDEO_DURATION_PRESETS,
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

describe('Polish-20: canSubmitState — Generate button gate', () => {
  const base = {
    modelId: 'kling_3_standard' as const,
    providerId: 'kie_ai' as const,
    variantCount: 5,
    durationSeconds: 30,
  };

  it('accepts a complete state (model picked, count valid, duration set)', () => {
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

  it('BLOCKS when durationSeconds is missing / non-positive', () => {
    expect(canSubmitState({ ...base, durationSeconds: 0 })).toBe(false);
    expect(canSubmitState({ ...base, durationSeconds: -5 })).toBe(false);
    expect(canSubmitState({ ...base, durationSeconds: NaN })).toBe(false);
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

describe('Polish-20: buildSubmissionFormData', () => {
  it('emits the FormData keys createGenerationJobAction reads (legacy compat + new fields)', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'concept_abc',
      legacyPipeline: defaultPipeline(),
      legacyVoiceId: '21m00Tcm4TlvDq8ikWAM',
      state: {
        modelId: 'kling_3_standard',
        providerId: 'kie_ai',
        variantCount: 5,
        durationSeconds: 30,
      },
    });
    // Legacy compat (Polish-20 Commit 1 keeps these so pre-Commit-2
    // dispatch still routes to a working worker):
    expect(fd.get('conceptId')).toBe('concept_abc');
    expect(fd.get('intensity')).toBe('medium'); // hardcoded; simplified form hides picker
    expect(fd.get('mode')).toBe('live');
    expect(fd.get('pipeline')).toBe(defaultPipeline());
    expect(fd.get('voiceId')).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(fd.get('variantCount')).toBe('5');
    // Polish-14.1 legacy name — worker's target duration.
    expect(fd.get('sourceDurationSeconds')).toBe('30');
    // Polish-20 NEW: descriptor-driven routing signals.
    expect(fd.get('modelId')).toBe('kling_3_standard');
    expect(fd.get('providerId')).toBe('kie_ai');
  });

  it('OMITS modelId + providerId when the state fields are null (defense-in-depth)', () => {
    // Should never happen in practice — canSubmitState blocks submit
    // when modelId is null — but defensively the builder skips the
    // field rather than writing 'null' string values the action
    // handler would parse.
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      legacyPipeline: defaultPipeline(),
      legacyVoiceId: 'v',
      state: {
        modelId: null,
        providerId: null,
        variantCount: 1,
        durationSeconds: 8,
      },
    });
    expect(fd.has('modelId')).toBe(false);
    expect(fd.has('providerId')).toBe(false);
  });

  it('always sends sourceDurationSeconds (worker Polish-19.3.1 fallback chain honors it)', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      legacyPipeline: defaultPipeline(),
      legacyVoiceId: 'v',
      state: {
        modelId: 'seedance_1_5_pro',
        providerId: 'kie_ai',
        variantCount: 3,
        durationSeconds: 15,
      },
    });
    expect(fd.get('sourceDurationSeconds')).toBe('15');
  });

  it('intensity + mode are always hardcoded (simplified form does not expose either)', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'c',
      legacyPipeline: defaultPipeline(),
      legacyVoiceId: 'v',
      state: {
        modelId: 'seedance_2',
        providerId: 'kie_ai',
        variantCount: 1,
        durationSeconds: 60,
      },
    });
    expect(fd.get('intensity')).toBe('medium');
    expect(fd.get('mode')).toBe('live');
  });
});

describe('Polish-20: SIMPLIFIED_DEFAULT_DURATION_SECONDS + preset table', () => {
  it('duration default is 30s (matches the most common UGC ad length)', () => {
    expect(SIMPLIFIED_DEFAULT_DURATION_SECONDS).toBe(30);
  });

  it('re-exported preset table matches the descriptor (8/15/30/60)', () => {
    expect(VIDEO_DURATION_PRESETS).toEqual([8, 15, 30, 60]);
  });
});
