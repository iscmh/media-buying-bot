/**
 * Pure-function tests for the Phase 3b cost calculators. Pricing is a
 * snapshot pinned in actual-cost.ts; if these break, re-pin the snapshot
 * AND update the test, intentionally. Don't loosen tolerances to make
 * stale numbers pass.
 */
import { describe, expect, it } from 'vitest';
import {
  PRICING_SNAPSHOT,
  computeClaudeCost,
  computeGeminiImageCost,
  computeGeminiTextCost,
  computeHeygenCost,
  computeKieAiCost,
} from '../src';

describe('Gemini text cost', () => {
  it('zero tokens → zero cost', () => {
    expect(computeGeminiTextCost({})).toBe(0);
  });

  it('1M input + 1M output matches the per-million rates', () => {
    const cost = computeGeminiTextCost({
      promptTokenCount: 1_000_000,
      candidatesTokenCount: 1_000_000,
    });
    expect(cost).toBeCloseTo(
      PRICING_SNAPSHOT.gemini25Flash.inputUsdPerM + PRICING_SNAPSHOT.gemini25Flash.outputUsdPerM,
      4,
    );
  });

  it('typical vision call (10K in, 1K out) is cents not dollars', () => {
    const cost = computeGeminiTextCost({
      promptTokenCount: 10_000,
      candidatesTokenCount: 1_000,
    });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.05); // < 5 cents
  });
});

describe('Gemini image cost', () => {
  it('flat per-image price', () => {
    expect(computeGeminiImageCost(1)).toBeCloseTo(PRICING_SNAPSHOT.gemini25FlashImage.perImageUsd);
    expect(computeGeminiImageCost(10)).toBeCloseTo(
      10 * PRICING_SNAPSHOT.gemini25FlashImage.perImageUsd,
    );
    expect(computeGeminiImageCost(0)).toBe(0);
  });
});

describe('Claude cost', () => {
  it('zero tokens → zero cost', () => {
    expect(computeClaudeCost({})).toBe(0);
  });

  it('1M input + 1M output matches the per-million rates', () => {
    const cost = computeClaudeCost({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(
      PRICING_SNAPSHOT.claudeSonnet4.inputUsdPerM + PRICING_SNAPSHOT.claudeSonnet4.outputUsdPerM,
      4,
    );
  });

  it('static variant gen (~5K in, 2K out) lands in single-cent territory', () => {
    const cost = computeClaudeCost({ input_tokens: 5_000, output_tokens: 2_000 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.1); // <10 cents
  });
});

describe('Per-video flat rates', () => {
  it('Kie.ai matches snapshot', () => {
    expect(computeKieAiCost()).toBeCloseTo(PRICING_SNAPSHOT.kieAiSora2.perVideoUsd);
  });

  it('HeyGen matches snapshot', () => {
    expect(computeHeygenCost()).toBeCloseTo(PRICING_SNAPSHOT.heygen.perVideoUsd);
  });

  it('snapshot values are in plausible ranges', () => {
    expect(PRICING_SNAPSHOT.kieAiSora2.perVideoUsd).toBeGreaterThan(0.5);
    expect(PRICING_SNAPSHOT.kieAiSora2.perVideoUsd).toBeLessThan(10);
    expect(PRICING_SNAPSHOT.heygen.perVideoUsd).toBeGreaterThan(0.05);
    expect(PRICING_SNAPSHOT.heygen.perVideoUsd).toBeLessThan(5);
  });
});
