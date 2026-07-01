/**
 * Pure-function test for the AI generation cost estimator.
 *
 * The math here is what shows up in the operator's cost-estimator card and
 * what the server-side cap guard checks. Drift between this test and the
 * source is drift between what the operator was told they'd pay and what
 * actually got billed — pin everything.
 */
import { describe, expect, it } from 'vitest';
import { estimateGenerationCost, MAX_VARIANTS_PER_JOB } from '../src';

describe('estimateGenerationCost', () => {
  describe('static', () => {
    it('1 variant: image $0.04 + copy $0.02 + ref $0.05 = $0.11', () => {
      const r = estimateGenerationCost({ conceptType: 'static', variantCount: 1 });
      expect(r.estimateUsd).toBeCloseTo(0.11, 4);
      expect(r.breakdown).toHaveLength(3);
    });

    it('10 variants: image $0.40 + copy $0.20 + ref $0.05 = $0.65', () => {
      const r = estimateGenerationCost({ conceptType: 'static', variantCount: 10 });
      expect(r.estimateUsd).toBeCloseTo(0.65, 4);
    });

    it('100 variants (cap): image $4.00 + copy $2.00 + ref $0.05 = $6.05', () => {
      const r = estimateGenerationCost({
        conceptType: 'static',
        variantCount: MAX_VARIANTS_PER_JOB,
      });
      expect(r.estimateUsd).toBeCloseTo(6.05, 4);
    });
  });

  describe('ugc', () => {
    it('throws when no provider given', () => {
      expect(() => estimateGenerationCost({ conceptType: 'ugc', variantCount: 5 })).toThrow();
    });

    it('Kie.ai (Sora 2), 1 variant: vision $0.10 + refine $0.05 + video $1.50 = $1.65', () => {
      const r = estimateGenerationCost({
        conceptType: 'ugc',
        variantCount: 1,
        provider: 'kie_ai',
      });
      expect(r.estimateUsd).toBeCloseTo(1.65, 4);
    });

    it('Kie.ai 10 variants: vision $0.10 + refine $0.50 + video $15.00 = $15.60', () => {
      const r = estimateGenerationCost({
        conceptType: 'ugc',
        variantCount: 10,
        provider: 'kie_ai',
      });
      expect(r.estimateUsd).toBeCloseTo(15.6, 4);
    });

    it('HeyGen 10 variants: vision $0.10 + refine $0.50 + video $3.00 = $3.60', () => {
      const r = estimateGenerationCost({
        conceptType: 'ugc',
        variantCount: 10,
        provider: 'heygen',
      });
      expect(r.estimateUsd).toBeCloseTo(3.6, 4);
    });

    it('Arcads 10 variants: vision $0.10 + refine $0.50 + video $5.00 = $5.60', () => {
      const r = estimateGenerationCost({
        conceptType: 'ugc',
        variantCount: 10,
        provider: 'arcads',
      });
      expect(r.estimateUsd).toBeCloseTo(5.6, 4);
    });

    it('100 variants (cap) with Kie.ai stays inside the platform AI ceiling', () => {
      const r = estimateGenerationCost({
        conceptType: 'ugc',
        variantCount: MAX_VARIANTS_PER_JOB,
        provider: 'kie_ai',
      });
      // Kie.ai 100 variants: vision $0.10 + refine $5.00 + video $150.00 = $155.10
      expect(r.estimateUsd).toBeCloseTo(155.1, 4);
      // Sanity: that single job alone fits under the $200 platform AI cap
      // but materially eats into a sane operator's daily allowance.
      expect(r.estimateUsd).toBeLessThan(200);
    });
  });

  it('breakdown line costs sum to the total estimate', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 17,
      provider: 'heygen',
    });
    const sum = r.breakdown.reduce((s, b) => s + b.cost, 0);
    expect(sum).toBeCloseTo(r.estimateUsd, 4);
  });
});

describe('MAX_VARIANTS_PER_JOB constant', () => {
  it('is 100', () => {
    expect(MAX_VARIANTS_PER_JOB).toBe(100);
  });
});

describe('Polish-20 Commit 4: surviving legacy-pipeline cost paths', () => {
  it('sora_2_single_shot: 3 variants = prompts $0.15 + videos $4.50 = $4.65', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 3,
      pipeline: 'sora_2_single_shot',
    });
    expect(r.estimateUsd).toBeCloseTo(4.65, 4);
  });

  it('nano_banana_static_image: 10 variants = claude $0.20 + images $0.40 = $0.60', () => {
    const r = estimateGenerationCost({
      conceptType: 'static',
      variantCount: 10,
      pipeline: 'nano_banana_static_image',
    });
    expect(r.estimateUsd).toBeCloseTo(0.6, 4);
  });

  it('defaults to avatar_talking_head pricing when format omitted', () => {
    const heygen = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 10,
      provider: 'heygen',
    });
    const explicit = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 10,
      provider: 'heygen',
      format: 'avatar_talking_head',
    });
    expect(explicit.estimateUsd).toBe(heygen.estimateUsd);
  });
});

describe('Polish-9.4 → Polish-20 Commit 4: pipeline-only call sites (no provider)', () => {
  it('ugc + pipeline=sora_2 + no provider → Sora price ($1.55)', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'sora_2_single_shot',
    });
    expect(r.estimateUsd).toBeCloseTo(1.55, 4);
  });

  it('ugc + pipeline=heygen + no provider → HeyGen price (does not throw)', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'heygen_avatar_talking_head',
    });
    // vision $0.10 + refine $0.05 + heygen $0.30 = $0.45
    expect(r.estimateUsd).toBeCloseTo(0.45, 4);
  });

  it('ugc + provider=heygen (no pipeline) STILL works (legacy)', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      provider: 'heygen',
    });
    expect(r.estimateUsd).toBeCloseTo(0.45, 4);
  });

  it('ugc + no provider + no pipeline STILL throws (no way to derive cost)', () => {
    expect(() => estimateGenerationCost({ conceptType: 'ugc', variantCount: 1 })).toThrow(
      /UGC cost estimate requires a provider/,
    );
  });
});

describe('Polish-20: estimateByVideoModel branch (descriptor-driven)', () => {
  // Cost formula per variant:
  //   $0.05 Claude script + billed_seconds × $/sec + $0.15 concat (if N>1)
  // billed_seconds = segmentCount × model.maxSingleCallSeconds

  // ---- Seedance 1.5 Pro (12s cap, $0.035/sec) ----
  //   8s  (1 seg,  billed 12s): 0.05 + 12×0.035           = $0.47
  //  15s  (2 segs, billed 24s): 0.05 + 24×0.035 + 0.15    = $1.04
  //  30s  (3 segs, billed 36s): 0.05 + 36×0.035 + 0.15    = $1.46
  //  60s  (5 segs, billed 60s): 0.05 + 60×0.035 + 0.15    = $2.30

  it('Seedance 1.5 Pro 8s → single segment, no concat', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_1_5_pro',
      sourceDurationSeconds: 8,
    });
    expect(r.estimateUsd).toBeCloseTo(0.47, 4);
    expect(r.breakdown.some((b) => /Replicate ffmpeg-concat/.test(b.item))).toBe(false);
  });

  it('Seedance 1.5 Pro 30s → 3 segments + concat', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_1_5_pro',
      sourceDurationSeconds: 30,
    });
    expect(r.estimateUsd).toBeCloseTo(1.46, 4);
    expect(r.breakdown.some((b) => /3 segments/.test(b.item))).toBe(true);
    expect(r.breakdown.some((b) => /Replicate ffmpeg-concat/.test(b.item))).toBe(true);
  });

  it('Seedance 1.5 Pro 60s → 5 segments + concat', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_1_5_pro',
      sourceDurationSeconds: 60,
    });
    expect(r.estimateUsd).toBeCloseTo(2.3, 4);
  });

  // ---- Kling 3.0 Standard (15s cap, $0.10/sec) ----
  //   8s  (1 seg,  billed 15s): 0.05 + 15×0.10           = $1.55
  //  15s  (1 seg,  billed 15s): 0.05 + 15×0.10           = $1.55
  //  30s  (2 segs, billed 30s): 0.05 + 30×0.10 + 0.15    = $3.20
  //  60s  (4 segs, billed 60s): 0.05 + 60×0.10 + 0.15    = $6.20

  it('Kling 3.0 Standard 15s → single segment (15s cap fits target)', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'kling_3_standard',
      sourceDurationSeconds: 15,
    });
    expect(r.estimateUsd).toBeCloseTo(1.55, 4);
    expect(r.breakdown.some((b) => /Replicate ffmpeg-concat/.test(b.item))).toBe(false);
  });

  it('Kling 3.0 Standard 30s → 2 segments + concat', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'kling_3_standard',
      sourceDurationSeconds: 30,
    });
    expect(r.estimateUsd).toBeCloseTo(3.2, 4);
    expect(r.breakdown.some((b) => /2 segments/.test(b.item))).toBe(true);
  });

  it('Kling 3.0 Standard 60s → 4 segments + concat', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'kling_3_standard',
      sourceDurationSeconds: 60,
    });
    expect(r.estimateUsd).toBeCloseTo(6.2, 4);
  });

  // ---- Seedance 2 (15s cap, $0.33/sec) ----
  //   8s  (1 seg,  billed 15s): 0.05 + 15×0.33           = $5.00
  //  30s  (2 segs, billed 30s): 0.05 + 30×0.33 + 0.15    = $10.10
  //  60s  (4 segs, billed 60s): 0.05 + 60×0.33 + 0.15    = $20.00

  it('Seedance 2 30s → 2 segments + concat', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_2',
      sourceDurationSeconds: 30,
    });
    expect(r.estimateUsd).toBeCloseTo(10.1, 4);
  });

  it('Seedance 2 60s → 4 segments + concat', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_2',
      sourceDurationSeconds: 60,
    });
    expect(r.estimateUsd).toBeCloseTo(20.0, 4);
  });

  // ---- Variant scaling ----

  it('scales linearly with variantCount: 5 × Kling 30s = $16.00', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 5,
      videoModelId: 'kling_3_standard',
      sourceDurationSeconds: 30,
    });
    expect(r.estimateUsd).toBeCloseTo(16.0, 4);
  });

  // ---- Precedence + defaults ----

  it('videoModelId wins over legacy `pipeline` field when both are set', () => {
    // If videoModelId routes correctly, we get the Kling 30s = $3.20;
    // if the legacy pipeline branch fired instead, the number would
    // differ (heygen_avatar_talking_head hits its own cost formula).
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'heygen_avatar_talking_head',
      videoModelId: 'kling_3_standard',
      sourceDurationSeconds: 30,
    });
    expect(r.estimateUsd).toBeCloseTo(3.2, 4);
  });

  it('sourceDurationSeconds wins over estimatedDurationSeconds', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_1_5_pro',
      sourceDurationSeconds: 8, // → 1 seg
      estimatedDurationSeconds: 60, // would be 5 segs, ignored
    });
    expect(r.estimateUsd).toBeCloseTo(0.47, 4);
  });

  it('defaults to 30s target when neither duration is provided', () => {
    // Missing duration → 30s → Seedance 1.5 Pro 3 segs → $1.46
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_1_5_pro',
    });
    expect(r.estimateUsd).toBeCloseTo(1.46, 4);
  });

  it('defaults provider to cheapest live provider when videoProviderId is omitted', () => {
    // At Polish-20 launch that is kie.ai for every model.
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_1_5_pro',
      sourceDurationSeconds: 30,
    });
    // Same result as passing 'kie_ai' explicitly.
    expect(r.estimateUsd).toBeCloseTo(1.46, 4);
  });

  it('returns $0 for unknown modelId (defensive — never crashes the form)', () => {
    // Cast around the compile-time enum guard.
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'nope' as never,
      sourceDurationSeconds: 30,
    });
    expect(r.estimateUsd).toBe(0);
    expect(r.breakdown).toEqual([]);
  });

  it('runaway duration clamps to 8-segment ceiling (matches segment-count cap)', () => {
    // Seedance 1.5 Pro 600s → 8 segs × 12s = 96s billed. Cost = 0.05 + 96×0.035 + 0.15 = $3.56.
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      videoModelId: 'seedance_1_5_pro',
      sourceDurationSeconds: 600,
    });
    expect(r.estimateUsd).toBeCloseTo(3.56, 4);
  });
});
