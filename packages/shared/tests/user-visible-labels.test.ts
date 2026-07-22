/**
 * Polish-25.2 Commit 12 regression pins.
 *
 * User walkthrough (job 3777cc76) surfaced multiple internal
 * terminology leaks across the UI: "Polish-25", "MakeUGC",
 * "Phase 4", "Phase 7", pipeline labels like "UGC ad (MakeUGC
 * pre-cast avatar — Polish-25)" showing on the run detail page.
 *
 * This suite pins the user-visible label set so any future edit
 * that re-introduces internal terminology into a descriptor
 * `label` fails CI before shipping.
 */
import { describe, expect, it } from 'vitest';
import { ALL_PIPELINES, describePipeline } from '../src';

const FORBIDDEN_PATTERNS: RegExp[] = [
  // Internal codename series.
  /Polish-\d+/i,
  /polish\d+/i,
  // Vendor names that leak into user-facing labels.
  /MakeUGC/i,
  // Internal phase language.
  /Phase\s+\d+/i,
];

describe('Polish-25.2 Commit 12: pipeline descriptor labels have no internal terminology', () => {
  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`no descriptor label matches ${pattern}`, () => {
      const offenders: Array<{ pipeline: string; label: string }> = [];
      for (const pipeline of ALL_PIPELINES) {
        const descriptor = describePipeline(pipeline);
        if (pattern.test(descriptor.label)) {
          offenders.push({ pipeline, label: descriptor.label });
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('polish25_makeugc descriptor label reads "Instant UGC ad"', () => {
    expect(describePipeline('polish25_makeugc').label).toBe('Instant UGC ad');
  });

  it('polish23_higgsfield_veo_lite descriptor label reads "Higgsfield UGC ad"', () => {
    expect(describePipeline('polish23_higgsfield_veo_lite').label).toBe('Higgsfield UGC ad');
  });

  it('heygen / sora / nano-banana labels are neutral product language', () => {
    expect(describePipeline('heygen_avatar_talking_head').label).toBe('Avatar talking head');
    expect(describePipeline('sora_2_single_shot').label).toBe('Single-shot video');
    expect(describePipeline('nano_banana_static_image').label).toBe('Static image');
  });
});
