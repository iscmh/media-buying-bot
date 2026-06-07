/**
 * Polish-10: Kling 3.0 Omni multi-segment worker — pure helpers
 * (computeSegmentCount, splitClipsIntoSegments, buildSegmentPrompt).
 * The Inngest function itself is integration-tested in production
 * via the Inngest dashboard; here we cover the prompt + split math.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSegmentPrompt,
  computeSegmentCount,
  splitClipsIntoSegments,
} from '../src/functions/generate-kling-3-omni-multi-segment';

describe('Polish-10: computeSegmentCount', () => {
  it('0 clips → 0 segments', () => {
    expect(computeSegmentCount(0)).toBe(0);
  });

  it('1-2 clips collapse to 1 segment', () => {
    expect(computeSegmentCount(1)).toBe(1);
    expect(computeSegmentCount(2)).toBe(1);
  });

  it('3+ clips → 2 segments (capped for cost)', () => {
    expect(computeSegmentCount(3)).toBe(2);
    expect(computeSegmentCount(6)).toBe(2);
    expect(computeSegmentCount(16)).toBe(2);
  });
});

describe('Polish-10: splitClipsIntoSegments', () => {
  it('6 clips into 2 segments → [3,3]', () => {
    const clips = [0, 1, 2, 3, 4, 5];
    const out = splitClipsIntoSegments(clips, 2);
    expect(out).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it('7 clips into 2 segments → [4,3]', () => {
    const clips = [0, 1, 2, 3, 4, 5, 6];
    const out = splitClipsIntoSegments(clips, 2);
    expect(out).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('16 clips into 2 segments → [8,8]', () => {
    const clips = Array.from({ length: 16 }, (_, i) => i);
    const out = splitClipsIntoSegments(clips, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(8);
    expect(out[1]).toHaveLength(8);
  });

  it('1 clip into 2 segments → drops empty trailing segment', () => {
    const out = splitClipsIntoSegments([42], 2);
    expect(out).toEqual([[42]]);
  });

  it('empty input → empty output', () => {
    expect(splitClipsIntoSegments([], 2)).toEqual([]);
    expect(splitClipsIntoSegments([1, 2], 0)).toEqual([]);
  });
});

describe('Polish-10: buildSegmentPrompt', () => {
  const manual = {
    // Forge-style: the "three-view character sheet" directive ends with
    // a period, then the actual character description follows in its
    // own sentence so the strip helper preserves it.
    characterPrompt:
      'Photorealistic three-view character sheet, front view, side view, back view. A 30yo woman with dark hair, wearing a blue cotton t-shirt.',
    setPrompt: 'Sunny morning kitchen with messy counter.',
  };

  it('outer prompt contains <<<image_1>>> reference + character + scene + multi-shot directive', () => {
    const r = buildSegmentPrompt(manual, [{ videoPrompt: 'Hold mug.', dialogue: 'Morning!' }], 15);
    expect(r.outerPrompt).toMatch(/<<<image_1>>>/);
    expect(r.outerPrompt).toMatch(/30yo woman/);
    expect(r.outerPrompt).toMatch(/messy counter/);
    expect(r.outerPrompt).toMatch(/single 15-second video/);
    expect(r.outerPrompt).toMatch(/connected shot/);
    expect(r.outerPrompt).toMatch(/AMATEUR SMARTPHONE SELFIE/);
    expect(r.outerPrompt).toMatch(/NATURAL CONVERSATIONAL pace/);
  });

  it('outer prompt strips the three-view character sheet directive', () => {
    const r = buildSegmentPrompt(manual, [{ videoPrompt: 'V' }], 15);
    expect(r.outerPrompt).not.toMatch(/three[\s-]view character sheet/i);
  });

  it('multi_prompt durations sum exactly to the segment duration', () => {
    const r3 = buildSegmentPrompt(
      manual,
      [{ videoPrompt: 'A' }, { videoPrompt: 'B' }, { videoPrompt: 'C' }],
      15,
    );
    expect(r3.multiPrompt).toHaveLength(3);
    const total3 = r3.multiPrompt.reduce((s, x) => s + x.duration, 0);
    expect(total3).toBe(15);
    expect(r3.multiPrompt.map((x) => x.duration)).toEqual([5, 5, 5]);

    const r4 = buildSegmentPrompt(
      manual,
      [{ videoPrompt: 'A' }, { videoPrompt: 'B' }, { videoPrompt: 'C' }, { videoPrompt: 'D' }],
      15,
    );
    const total4 = r4.multiPrompt.reduce((s, x) => s + x.duration, 0);
    expect(total4).toBe(15);
    // 15/4=3 with remainder 3 → first 3 shots get 4s, last gets 3s.
    expect(r4.multiPrompt.map((x) => x.duration)).toEqual([4, 4, 4, 3]);
  });

  it('caps shots at the Kling Omni 6-shot ceiling', () => {
    const clips = Array.from({ length: 10 }, (_, i) => ({
      videoPrompt: `shot ${i + 1}`,
    }));
    const r = buildSegmentPrompt(manual, clips, 15);
    expect(r.multiPrompt).toHaveLength(6);
    const total = r.multiPrompt.reduce((s, x) => s + x.duration, 0);
    expect(total).toBe(15);
  });

  it('each shot prompt is prefixed with <<<image_1>>> when missing', () => {
    const r = buildSegmentPrompt(
      manual,
      [{ videoPrompt: 'Hold mug, smile.' }, { videoPrompt: '<<<image_1>>> Pour coffee.' }],
      15,
    );
    expect(r.multiPrompt[0]!.prompt).toMatch(/^<<<image_1>>>/);
    // Already-prefixed prompts are kept verbatim, not double-prefixed.
    expect(r.multiPrompt[1]!.prompt.match(/<<<image_1>>>/g)).toHaveLength(1);
  });

  it('appends [GENERATE NATIVE AUDIO AND LIP-SYNC ...] for each shot with dialogue', () => {
    const r = buildSegmentPrompt(manual, [{ videoPrompt: 'Hold mug.', dialogue: 'Morning!' }], 15);
    expect(r.multiPrompt[0]!.prompt).toMatch(/GENERATE NATIVE AUDIO AND LIP-SYNC/);
    expect(r.multiPrompt[0]!.prompt).toMatch(/"Morning!"/);
  });

  it('outer prompt concatenates dialogues into one continuous-monologue line', () => {
    const r = buildSegmentPrompt(
      manual,
      [
        { videoPrompt: 'A', dialogue: 'Hi there.' },
        { videoPrompt: 'B', dialogue: 'Today I want to talk about coffee.' },
      ],
      15,
    );
    expect(r.outerPrompt).toMatch(/one continuous monologue/);
    expect(r.outerPrompt).toMatch(/"Hi there\."/);
    expect(r.outerPrompt).toMatch(/"Today I want to talk about coffee\."/);
  });
});
