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
