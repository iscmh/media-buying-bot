/**
 * Polish-10: Kling 3.0 Omni multi-segment worker — pure helpers
 * (computeSegmentCount, splitClipsIntoSegments, buildSegmentPrompt).
 * The Inngest function itself is integration-tested in production
 * via the Inngest dashboard; here we cover the prompt + split math.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSegmentPrompt,
  compressShotPrompt,
  computeSegmentCount,
  extractAudioDirectives,
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

  it('Polish-10.2: shot bodies do NOT carry [GENERATE NATIVE AUDIO ...] (consolidated into outer prompt)', () => {
    const r = buildSegmentPrompt(manual, [{ videoPrompt: 'Hold mug.', dialogue: 'Morning!' }], 15);
    expect(r.multiPrompt[0]!.prompt).not.toMatch(/GENERATE NATIVE AUDIO AND LIP-SYNC/);
    expect(r.multiPrompt[0]!.prompt).not.toMatch(/"Morning!"/);
  });

  it('Polish-10.2: outer prompt aggregates dialogue into a single Audio-across-the-segment line', () => {
    const r = buildSegmentPrompt(
      manual,
      [
        { videoPrompt: 'A', dialogue: 'Hi there.' },
        { videoPrompt: 'B', dialogue: 'Today I want to talk about coffee.' },
      ],
      15,
    );
    expect(r.outerPrompt).toMatch(/Audio across the segment/);
    expect(r.outerPrompt).toMatch(/"Hi there\."/);
    expect(r.outerPrompt).toMatch(/"Today I want to talk about coffee\."/);
  });

  it('Polish-10.2: outer prompt fits under the 2500-char Kling Omni limit', () => {
    const longClip = {
      videoPrompt: 'Hold mug, smile.'.repeat(50),
      dialogue: 'This is a long dialogue line.'.repeat(20),
    };
    const r = buildSegmentPrompt(manual, [longClip, longClip], 15);
    expect(r.outerPrompt.length).toBeLessThanOrEqual(2500);
  });

  it('Polish-10.2: every shot body stays under the 512-char Kling Omni limit', () => {
    const longClip = {
      videoPrompt:
        '[USE IMAGE 1 AS STARTING FRAME] Subject: SARAH, ref: 123, 30yo woman, US accent. ' +
        'Static iPhone shot. ' +
        'Hold mug, smile widens, eyebrows raise, head tilts slightly to the right '.repeat(20) +
        '[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "' +
        'Hi I am drinking coffee in my kitchen.'.repeat(15) +
        '"',
      dialogue: 'Hi I am drinking coffee.',
    };
    const r = buildSegmentPrompt(manual, [longClip, longClip], 15);
    for (const shot of r.multiPrompt) {
      expect(shot.prompt.length).toBeLessThan(512);
    }
  });
});

describe('Polish-10.2: compressShotPrompt', () => {
  it('strips [USE IMAGE X AS STARTING FRAME] directives', () => {
    const out = compressShotPrompt({
      videoPrompt: '[USE IMAGE 1 AS STARTING FRAME] Hold mug, smile.',
    });
    expect(out).not.toMatch(/USE IMAGE/i);
    expect(out).toMatch(/^<<<image_1>>>/);
    expect(out).toMatch(/Hold mug, smile\./);
  });

  it('strips [GENERATE NATIVE AUDIO ...]: "dialogue" bracket directives', () => {
    const out = compressShotPrompt({
      videoPrompt:
        'Hold mug. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Morning!" Smile.',
    });
    expect(out).not.toMatch(/GENERATE NATIVE AUDIO/i);
    expect(out).not.toMatch(/"Morning!"/);
    expect(out).toMatch(/Hold mug\..*Smile\./);
  });

  it('always prepends <<<image_1>>>', () => {
    expect(compressShotPrompt({ videoPrompt: 'Body.' })).toMatch(/^<<<image_1>>>/);
  });

  it('does NOT double-prefix when <<<image_N>>> already present', () => {
    const out = compressShotPrompt({ videoPrompt: '<<<image_2>>> Already tagged.' });
    expect(out.match(/<<<image_\d+>>>/g)).toHaveLength(1);
  });

  it('collapses runs of whitespace into single spaces', () => {
    const out = compressShotPrompt({
      videoPrompt: 'Hold mug.\n\n\n   Smile widely.\n\n  Eyes raise.',
    });
    expect(out).not.toMatch(/ {2}/);
    expect(out).not.toMatch(/\n/);
  });

  it('hard-truncates at maxChars with ellipsis (default 480)', () => {
    const body = 'Hold mug and slowly raise eyebrows.'.repeat(50);
    const out = compressShotPrompt({ videoPrompt: body });
    expect(out.length).toBeLessThanOrEqual(480);
    expect(out.endsWith('...')).toBe(true);
  });

  it('passes short input through unchanged after prefix', () => {
    const out = compressShotPrompt({ videoPrompt: 'Quick smile.' });
    expect(out).toBe('<<<image_1>>> Quick smile.');
  });

  it('honors custom maxChars', () => {
    const out = compressShotPrompt({ videoPrompt: 'a'.repeat(100) }, 50);
    expect(out.length).toBeLessThanOrEqual(50);
  });
});

describe('Polish-10.2: extractAudioDirectives', () => {
  it('pulls dialogue from the master-prompt bracket form', () => {
    const out = extractAudioDirectives([
      {
        videoPrompt:
          'Hold mug. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Hello." Smile.',
      },
    ]);
    expect(out).toMatch(/Audio across the segment/);
    expect(out).toMatch(/"Hello\."/);
  });

  it('aggregates dialogue across multiple clips in order', () => {
    const out = extractAudioDirectives([
      {
        videoPrompt: '[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "First line."',
      },
      {
        videoPrompt: '[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Second line."',
      },
    ]);
    expect(out.indexOf('"First line."')).toBeLessThan(out.indexOf('"Second line."'));
  });

  it('falls back to clip.dialogue when the bracket form is absent', () => {
    const out = extractAudioDirectives([{ videoPrompt: 'No directive here.', dialogue: 'Hi.' }]);
    expect(out).toMatch(/"Hi\."/);
  });

  it('dedupes when bracket + clip.dialogue carry the same line', () => {
    const out = extractAudioDirectives([
      {
        videoPrompt: '[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Hi."',
        dialogue: 'Hi.',
      },
    ]);
    expect(out.match(/"Hi\."/g)).toHaveLength(1);
  });

  it('returns empty string when no clip has audio cues', () => {
    expect(extractAudioDirectives([{ videoPrompt: 'B-roll only.' }])).toBe('');
  });
});
