import { describe, expect, it } from 'vitest';
import {
  POLISH25_PIPELINE_ID,
  POLISH26_DESCRIPTION,
  POLISH26_DISPLAY_NAME,
  POLISH26_PIPELINE_ID,
  buildSubmissionFormData,
  estimatePolish26CostPerVariantUsd,
} from '../simplified-form-helpers';

/**
 * Polish-26.0.5 Commit 61.5 tripwires. The three behaviors that
 * would silently misroute an Instant UGC generation if they drifted:
 *
 *   1. Default "Instant UGC ad" click (polish26Selected=true) MUST
 *      dispatch pipeline=polish26_heygen — not polish25_makeugc.
 *      Pre-61.5 the form dispatched polish25 which routed to the
 *      MakeUGC worker → 0 credits until Aug 9 → guaranteed fail.
 *   2. polish25 dispatch MUST stay callable for API/legacy callers
 *      that explicitly pass polish25Selected. The user-facing form
 *      no longer sets that field, but @mbb/api-v1 does.
 *   3. Cost preview MUST reflect HeyGen per-second billing ($0.02
 *      Claude + $0.00833/sec × duration = $0.27 at 30s default,
 *      not the flat $0.07 MakeUGC value).
 */

describe('polish26_heygen dispatch (Commit 61.5)', () => {
  it('polish26Selected=true dispatches pipeline=polish26_heygen', () => {
    const fd = buildSubmissionFormData({
      conceptId: 'concept-1',
      state: {
        modelId: null,
        providerId: null,
        variantCount: 1,
        polish26Selected: true,
      },
    });
    expect(fd.get('pipeline')).toBe(POLISH26_PIPELINE_ID);
    expect(fd.get('pipeline')).toBe('polish26_heygen');
  });

  it('polish26 takes precedence over polish25 when both flags are set', () => {
    // Defense-in-depth: if a bug ever sets both, we route to the
    // NEW backend rather than the deprecated MakeUGC one.
    const fd = buildSubmissionFormData({
      conceptId: 'concept-1',
      state: {
        modelId: null,
        providerId: null,
        variantCount: 1,
        polish25Selected: true,
        polish26Selected: true,
      },
    });
    expect(fd.get('pipeline')).toBe(POLISH26_PIPELINE_ID);
  });

  it('polish25Selected alone still dispatches polish25_makeugc (API back-compat)', () => {
    // Post-61.5 the user-facing form doesn't set polish25Selected,
    // but /api/v1/generations with pipeline=polish25_makeugc still
    // works — this test pins that back-compat path.
    const fd = buildSubmissionFormData({
      conceptId: 'concept-1',
      state: {
        modelId: null,
        providerId: null,
        variantCount: 1,
        polish25Selected: true,
      },
    });
    expect(fd.get('pipeline')).toBe(POLISH25_PIPELINE_ID);
    expect(fd.get('pipeline')).toBe('polish25_makeugc');
  });

  it("POLISH26_DISPLAY_NAME keeps the user-visible 'Instant UGC ad' string", () => {
    // Copy stability — flipping the backend doesn't change the card
    // label. Users see the same "Instant UGC ad" they saw pre-61.5.
    expect(POLISH26_DISPLAY_NAME).toBe('Instant UGC ad');
    expect(POLISH26_DESCRIPTION).toContain('HeyGen');
    expect(POLISH26_DESCRIPTION).toContain('Character consistency');
  });
});

describe('estimatePolish26CostPerVariantUsd (Commit 61.5)', () => {
  it('defaults to a 30-sec source ⇒ $0.27 per variant', () => {
    // $0.02 Claude condenser + $0.50/min × 30s = $0.25 = $0.27 total.
    // Pinned exactly so a future refactor doesn't silently drift the
    // cost preview.
    const { usd } = estimatePolish26CostPerVariantUsd(null);
    expect(usd).toBeCloseTo(0.27, 4);
  });

  it('scales linearly with sourceDurationSeconds (HeyGen bills per second)', () => {
    // 60-sec hook = $0.02 + $0.50 = $0.52
    expect(estimatePolish26CostPerVariantUsd(60).usd).toBeCloseTo(0.52, 4);
    // 15-sec hook = $0.02 + $0.125 = $0.145
    expect(estimatePolish26CostPerVariantUsd(15).usd).toBeCloseTo(0.145, 4);
    // 120-sec hook = $0.02 + $1.00 = $1.02
    expect(estimatePolish26CostPerVariantUsd(120).usd).toBeCloseTo(1.02, 4);
  });

  it('non-positive / non-finite durations fall back to the 30-sec default', () => {
    expect(estimatePolish26CostPerVariantUsd(0).usd).toBeCloseTo(0.27, 4);
    expect(estimatePolish26CostPerVariantUsd(-5).usd).toBeCloseTo(0.27, 4);
  });
});
