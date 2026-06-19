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

describe('Polish-4: cinematic_voiceover cost path', () => {
  it('skips Sora prompt refinement + uses Kling+TTS+prompt-build line items', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      provider: 'heygen',
      format: 'cinematic_voiceover',
    });
    // vision $0.10 + prompt-build $0.01 + Kling $0.35 + TTS $0.06 = $0.52
    // (Polish-9.17: Kling per-clip bumped $0.30 → $0.35 on kling-v2.6.)
    expect(r.estimateUsd).toBeCloseTo(0.52, 4);
    const items = r.breakdown.map((b) => b.item);
    expect(items.some((i) => i.includes('Kling'))).toBe(true);
    expect(items.some((i) => i.includes('ElevenLabs'))).toBe(true);
    expect(items.some((i) => i.includes('Cinematic prompt'))).toBe(true);
    expect(items.some((i) => i.includes('Sora') || i.includes('HeyGen'))).toBe(false);
  });

  it('10 cinematic variants ≈ vision $0.10 + prompts $0.10 + kling $3.50 + tts $0.60 = $4.30', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 10,
      provider: 'heygen',
      format: 'cinematic_voiceover',
    });
    expect(r.estimateUsd).toBeCloseTo(4.3, 4);
  });

  it('kling_3_multi_clip: 1 variant = manual $0.10 + 16 clips × $0.35 + TTS $0.06 + lipsync $1.00 = $6.76', () => {
    // Polish-11: ElevenLabs voiceover + Replicate lipsync layers
    // bumped per-variant from $5.70 to ≈$6.76.
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kling_3_multi_clip_native_lipsync',
    });
    expect(r.estimateUsd).toBeCloseTo(6.76, 4);
    expect(r.breakdown.some((b) => b.item.includes('Kling'))).toBe(true);
    expect(r.breakdown.some((b) => b.item.includes('ElevenLabs'))).toBe(true);
    expect(r.breakdown.some((b) => b.item.includes('Lipsync'))).toBe(true);
  });

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

describe('Polish-9.4: pipeline-only call sites (no provider)', () => {
  it('ugc + pipeline=kling_3 + no provider → kling-multi-clip price (~$6.76 after Polish-11)', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kling_3_multi_clip_native_lipsync',
    });
    expect(r.estimateUsd).toBeCloseTo(6.76, 4);
  });

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

describe('Polish-12.1: kie_omni_flash_native cost scales with segment count', () => {
  it('≤10s → 1 segment, no stitch: $0.05 + $0.05 + $0.90 = $1.00', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      estimatedDurationSeconds: 10,
    });
    // Polish-12.4: +$0.15 character registration → $1.15 total.
    expect(r.estimateUsd).toBeCloseTo(1.15, 4);
    expect(r.breakdown.some((b) => /1 segment\b/.test(b.item))).toBe(true);
    expect(r.breakdown.some((b) => /stitching/.test(b.item))).toBe(false);
    expect(r.breakdown.some((b) => /character registration/i.test(b.item))).toBe(true);
  });

  it('≤20s → 2 segments + stitch: $0.05 + $0.05 + $1.80 + $0.05 = $1.95', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      estimatedDurationSeconds: 20,
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 1 frame extract → $2.12.
    expect(r.estimateUsd).toBeCloseTo(2.12, 4);
    expect(r.breakdown.some((b) => /2 segments\b/.test(b.item))).toBe(true);
    expect(r.breakdown.some((b) => /idan054 video stitching/.test(b.item))).toBe(true);
    expect(r.breakdown.some((b) => /Chain-continuity frame extracts/.test(b.item))).toBe(true);
  });

  it('>20s → 3 segments + stitch: $0.05 + $0.05 + $2.70 + $0.05 = $2.85', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      estimatedDurationSeconds: 30,
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 2 frame extracts → $3.04.
    expect(r.estimateUsd).toBeCloseTo(3.04, 4);
    expect(r.breakdown.some((b) => /3 segments\b/.test(b.item))).toBe(true);
  });

  it('estimatedDurationSeconds omitted → worst-case 3 segments + stitch ($2.85)', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 2 frame extracts → $3.04.
    expect(r.estimateUsd).toBeCloseTo(3.04, 4);
    expect(r.breakdown.some((b) => /3 segments\b/.test(b.item))).toBe(true);
  });
});

describe('Polish-14: kie_omni_flash_native cost scales linearly past 30s', () => {
  // Polish-14 removed the 3-segment cap. Cost now scales linearly
  // with duration via ceil(seconds / 10), bounded by the worker's
  // sanity ceiling of 30 segments (5 minutes). Existing ≤30s cases
  // stay unchanged (back-compat with Polish-12.1.x tests above).

  it('60s → 6 segments: $0.05 + $0.05 + $5.40 + $0.05 = $5.55', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      estimatedDurationSeconds: 60,
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 5 frame extracts → $5.80.
    expect(r.estimateUsd).toBeCloseTo(5.8, 4);
    expect(r.breakdown.some((b) => /6 segments\b/.test(b.item))).toBe(true);
  });

  it('90s → 9 segments: $0.05 + $0.05 + $8.10 + $0.05 = $8.25', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      estimatedDurationSeconds: 90,
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 8 frame extracts → $8.56.
    expect(r.estimateUsd).toBeCloseTo(8.56, 4);
    expect(r.breakdown.some((b) => /9 segments\b/.test(b.item))).toBe(true);
  });

  it('120s → 12 segments: $0.05 + $0.05 + $10.80 + $0.05 = $10.95', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      estimatedDurationSeconds: 120,
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 11 frame extracts → $11.32.
    expect(r.estimateUsd).toBeCloseTo(11.32, 4);
    expect(r.breakdown.some((b) => /12 segments\b/.test(b.item))).toBe(true);
  });

  it('600s (10 min) → caps at 30 segments: $0.05 + $0.05 + $27.00 + $0.05 = $27.15', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      estimatedDurationSeconds: 600,
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 29 frame extracts → $27.88.
    expect(r.estimateUsd).toBeCloseTo(27.88, 4);
    expect(r.breakdown.some((b) => /30 segments\b/.test(b.item))).toBe(true);
  });

  it('boundary: 31s → 4 segments (ceil(31/10) = 4)', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      estimatedDurationSeconds: 31,
    });
    // Polish-12.4 + 12.5. Total $0.05 + $0.05 + $0.15 + 4 × $0.90
    // + $0.05 stitch + 3 × $0.02 frame extract = $3.96.
    expect(r.estimateUsd).toBeCloseTo(3.96, 4);
    expect(r.breakdown.some((b) => /4 segments\b/.test(b.item))).toBe(true);
  });
});

describe('Polish-14.1: sourceDurationSeconds drives the kie_omni_flash_native quote', () => {
  // Polish-14.1 lets the form pass the actual detected source-video
  // duration into the estimator so the upfront cost preview matches
  // what the worker will generate. sourceDurationSeconds wins over
  // estimatedDurationSeconds when both are present; back-compat is
  // preserved when neither is supplied.

  it('sourceDurationSeconds=18 → 2 segments → $1.95', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      sourceDurationSeconds: 18,
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 1 frame extract → $2.12.
    expect(r.estimateUsd).toBeCloseTo(2.12, 4);
    expect(r.breakdown.some((b) => /2 segments\b/.test(b.item))).toBe(true);
  });

  it('sourceDurationSeconds=60 → 6 segments → $5.55', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      sourceDurationSeconds: 60,
    });
    // Polish-12.4 +$0.15 char + Polish-12.5 +$0.02 × 5 frame extracts → $5.80.
    expect(r.estimateUsd).toBeCloseTo(5.8, 4);
    expect(r.breakdown.some((b) => /6 segments\b/.test(b.item))).toBe(true);
  });

  it('sourceDurationSeconds wins over estimatedDurationSeconds when both passed', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
      sourceDurationSeconds: 18,
      estimatedDurationSeconds: 90, // would imply 9 segments
    });
    // Source wins → 2 segments → $1.95 + $0.15 character + $0.02
    // chain-frame-extract = $2.12.
    expect(r.estimateUsd).toBeCloseTo(2.12, 4);
  });

  it('back-compat: neither source nor estimated supplied → 30s default → $3.04 (post-12.5)', () => {
    const r = estimateGenerationCost({
      conceptType: 'ugc',
      variantCount: 1,
      pipeline: 'kie_omni_flash_native',
    });
    // Polish-12.5: 3 segments → 2 frame extracts → $3.00 + $0.04 = $3.04.
    expect(r.estimateUsd).toBeCloseTo(3.04, 4);
  });
});
