/**
 * Polish-12: Gemini Omni Flash worker — pure helper coverage.
 *   - buildContinuousMonologue: clip.dialogue join order, body-quote
 *     fallback, dedupe, empty-input handling.
 *   - buildOmniFlashPrompt: KIE_OMNI_FLASH_HARD_DIRECTIVE prepended;
 *     scrubbed character / scene; dialogue concatenated into one
 *     continuous-monologue block; pacing instruction includes
 *     duration; three-view character sheet directive stripped;
 *     caption / b-roll language stripped.
 *
 * The Inngest function itself is integration-tested via the Inngest
 * dashboard — these tests cover the prompt math.
 */
import { describe, expect, it } from 'vitest';
import {
  buildContinuousMonologue,
  buildOmniFlashPrompt,
  buildOmniFlashSegmentPrompt,
  clampOmniDuration,
  estimateDialogueSeconds,
  splitClipsIntoOmniSegments,
} from '../src/functions/generate-kie-omni-flash-native';

describe('Polish-12: buildContinuousMonologue', () => {
  const mk = (overrides: Partial<{ videoPrompt: string; dialogue: string }>) => ({
    videoPrompt: overrides.videoPrompt ?? 'Body.',
    dialogue: overrides.dialogue,
  });

  it('joins clip.dialogue values in order, each wrapped in quotes', () => {
    const out = buildContinuousMonologue([
      mk({ dialogue: 'Hi there.' }),
      mk({ dialogue: 'I tried this product.' }),
      mk({ dialogue: 'Click below.' }),
    ]);
    expect(out).toBe('"Hi there." "I tried this product." "Click below."');
  });

  it('falls back to quoted-string match on the scrubbed body when clip.dialogue is missing', () => {
    const out = buildContinuousMonologue([
      mk({
        videoPrompt:
          'Static iPhone shot. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Morning!" Smile.',
      }),
    ]);
    expect(out).toBe('"Morning!"');
  });

  it('dedupes consecutive identical dialogue lines (parser + body echo)', () => {
    const out = buildContinuousMonologue([
      mk({ dialogue: 'Same line.' }),
      mk({ dialogue: 'Same line.' }),
      mk({ dialogue: 'Different.' }),
    ]);
    expect(out).toBe('"Same line." "Different."');
  });

  it('skips clips with no extractable dialogue', () => {
    const out = buildContinuousMonologue([
      mk({ dialogue: 'Hi.' }),
      mk({ videoPrompt: 'B-roll only.' }),
      mk({ dialogue: 'Bye.' }),
    ]);
    expect(out).toBe('"Hi." "Bye."');
  });

  it('returns empty string when no clip carries dialogue', () => {
    expect(buildContinuousMonologue([mk({ videoPrompt: 'b-roll' })])).toBe('');
    expect(buildContinuousMonologue([])).toBe('');
  });
});

describe('Polish-12: buildOmniFlashPrompt', () => {
  const manual = {
    characterPrompt:
      'Photorealistic three-view character sheet, front view, side view, back view. A 30yo woman with dark hair, wearing a blue cotton t-shirt. Lower-third caption shows her name.',
    setPrompt: 'Sunny morning kitchen. B-roll cutaway to coffee beans appears occasionally.',
    clips: [
      { videoPrompt: 'Hold mug.', dialogue: 'Hi, I want to talk about my morning routine.' },
      { videoPrompt: 'Sip coffee.', dialogue: 'This product changed my life.' },
    ],
  };

  it('prepends KIE_OMNI_FLASH_HARD_DIRECTIVE first', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out.startsWith('ABSOLUTE REQUIREMENTS')).toBe(true);
    expect(out).toMatch(/AMATEUR SMARTPHONE SELFIE VIDEO/);
    expect(out).toMatch(/ABSOLUTELY NO: captions/);
    expect(out).toMatch(/ABSOLUTELY NO: cinematic lighting/);
  });

  it('strips the three-view character sheet directive', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out).not.toMatch(/three[\s-]view character sheet/i);
  });

  it('strips caption / b-roll language from user-supplied character + scene', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out).not.toMatch(/Lower-third caption shows her name/i);
    expect(out).not.toMatch(/B-roll cutaway to coffee beans/i);
  });

  it('preserves the surviving character + scene content', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out).toMatch(/30yo woman/);
    expect(out).toMatch(/blue cotton t-shirt/);
    expect(out).toMatch(/Sunny morning kitchen/);
  });

  it('concatenates dialogues into one DIALOGUE block (Polish-12.1 phrasing)', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    // Polish-12.1 unified single-call + multi-segment under one
    // builder; the dialogue block label is the segment-builder's
    // "speaks the following lines naturally to camera" form now.
    expect(out).toMatch(/DIALOGUE.*speaks the following lines/);
    expect(out).toMatch(/"Hi, I want to talk about my morning routine\."/);
    expect(out).toMatch(/"This product changed my life\."/);
  });

  it('reports the actual duration in the pacing block', () => {
    const out10 = buildOmniFlashPrompt(manual, 10);
    expect(out10).toMatch(/10-second duration/);
    const out6 = buildOmniFlashPrompt(manual, 6);
    expect(out6).toMatch(/6-second duration/);
  });

  it('falls back to natural-ambient when no clip carries dialogue', () => {
    const out = buildOmniFlashPrompt(
      {
        characterPrompt: 'A 30yo woman.',
        setPrompt: 'A sunny kitchen.',
        clips: [{ videoPrompt: 'b-roll only', dialogue: undefined }],
      },
      10,
    );
    expect(out).toMatch(/No dialogue — natural ambient sound only/);
  });

  it('emits a single CHARACTER + SCENE block per call (no duplicates)', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out.match(/^CHARACTER:/gm)).toHaveLength(1);
    expect(out.match(/^SCENE \/ SET:/gm)).toHaveLength(1);
  });
});

describe('Polish-12.1: estimateDialogueSeconds (150 wpm)', () => {
  it('0 words → 0 seconds', () => {
    expect(estimateDialogueSeconds('')).toBe(0);
    expect(estimateDialogueSeconds('   ')).toBe(0);
  });

  it('15 words → 6 seconds (15/150 × 60)', () => {
    const text =
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
    expect(estimateDialogueSeconds(text)).toBeCloseTo(6, 4);
  });

  it('150 words → 60 seconds (1 minute)', () => {
    const text = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ');
    expect(estimateDialogueSeconds(text)).toBeCloseTo(60, 4);
  });

  it('collapses multi-space whitespace into single words', () => {
    expect(estimateDialogueSeconds('one    two   three')).toBeCloseTo(1.2, 4);
  });
});

describe('Polish-12.1: clampOmniDuration', () => {
  it('rounds up to the next Omni-allowed value', () => {
    expect(clampOmniDuration(2)).toBe(4);
    expect(clampOmniDuration(4)).toBe(4);
    expect(clampOmniDuration(5)).toBe(6);
    expect(clampOmniDuration(6)).toBe(6);
    expect(clampOmniDuration(7)).toBe(8);
    expect(clampOmniDuration(8)).toBe(8);
    expect(clampOmniDuration(9)).toBe(10);
    expect(clampOmniDuration(10)).toBe(10);
  });

  it('clamps anything > 10 down to 10', () => {
    expect(clampOmniDuration(11)).toBe(10);
    expect(clampOmniDuration(30)).toBe(10);
  });

  it('handles 0 / negative input', () => {
    expect(clampOmniDuration(0)).toBe(4);
    expect(clampOmniDuration(-5)).toBe(4);
  });
});

describe('Polish-12.1: splitClipsIntoOmniSegments', () => {
  // Helper: build a clip whose dialogue word count maps to the target
  // duration via the 150 wpm rate (so wordCount = seconds × 2.5).
  function clipForSeconds(
    seconds: number,
    label: string,
  ): { videoPrompt: string; dialogue: string } {
    const words = Math.max(1, Math.round((seconds / 60) * 150));
    return {
      videoPrompt: `Action ${label}.`,
      dialogue: `${label} ${Array.from({ length: words - 1 }, (_, i) => `w${i}`).join(' ')}`,
    };
  }

  it('empty clips → 0 segments', () => {
    expect(splitClipsIntoOmniSegments([])).toEqual([]);
  });

  it('1 clip with ~5s dialogue → 1 segment', () => {
    const segments = splitClipsIntoOmniSegments([clipForSeconds(5, 'A')]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.clips).toHaveLength(1);
    expect(segments[0]!.combinedDialogue).toMatch(/"A /);
  });

  it('3 clips ~4s each (≈12s total) → 2 balanced segments', () => {
    const segments = splitClipsIntoOmniSegments([
      clipForSeconds(4, 'A'),
      clipForSeconds(4, 'B'),
      clipForSeconds(4, 'C'),
    ]);
    expect(segments).toHaveLength(2);
    // Boundary preserved — no clip split.
    const totalClips = segments.reduce((s, x) => s + x.clips.length, 0);
    expect(totalClips).toBe(3);
    // Each segment fits within the 10s ceiling.
    for (const s of segments) {
      expect(s.estimatedDurationSeconds).toBeLessThanOrEqual(10);
    }
  });

  it('6 clips ~4-5s each (~28s total) → 3 balanced segments', () => {
    const segments = splitClipsIntoOmniSegments([
      clipForSeconds(5, 'A'),
      clipForSeconds(5, 'B'),
      clipForSeconds(5, 'C'),
      clipForSeconds(5, 'D'),
      clipForSeconds(4, 'E'),
      clipForSeconds(4, 'F'),
    ]);
    expect(segments).toHaveLength(3);
    const totalClips = segments.reduce((s, x) => s + x.clips.length, 0);
    expect(totalClips).toBe(6);
  });

  it('8 clips totaling > 30s → capped at 3 segments, last segment may overflow target', () => {
    const segments = splitClipsIntoOmniSegments(
      Array.from({ length: 8 }, (_, i) => clipForSeconds(6, `C${i}`)),
    );
    expect(segments).toHaveLength(3);
    const totalClips = segments.reduce((s, x) => s + x.clips.length, 0);
    expect(totalClips).toBe(8);
  });

  it('preserves clip boundaries — a single clip never spans segments', () => {
    const segments = splitClipsIntoOmniSegments([
      clipForSeconds(6, 'A'),
      clipForSeconds(6, 'B'),
      clipForSeconds(6, 'C'),
    ]);
    // 18s / 2 segments = 9s/segment target. The 6+6 = 12s first
    // segment WOULD overflow the 10s cap, so the boundary lands
    // between clip 1 and clip 2 — not in the middle of clip 1.
    expect(segments).toHaveLength(2);
    expect(segments[0]!.clips).toHaveLength(1);
    expect(segments[1]!.clips).toHaveLength(2);
  });

  it('builds combinedDialogue as space-separated quoted lines per segment', () => {
    const segments = splitClipsIntoOmniSegments([
      clipForSeconds(4, 'A'),
      clipForSeconds(4, 'B'),
      clipForSeconds(4, 'C'),
    ]);
    for (const s of segments) {
      // Each segment's monologue contains 1+ quoted line.
      expect(s.combinedDialogue).toMatch(/^".+"/);
    }
  });
});

describe('Polish-12.1: buildOmniFlashSegmentPrompt', () => {
  it('prepends KIE_OMNI_FLASH_HARD_DIRECTIVE then CHARACTER + SCENE + DIALOGUE', () => {
    const out = buildOmniFlashSegmentPrompt({
      characterDescription: 'A 30yo woman with dark hair.',
      sceneDescription: 'Sunny kitchen.',
      segmentDialogue: '"Hello there." "How are you?"',
      segmentDurationSeconds: 8,
    });
    expect(out.startsWith('ABSOLUTE REQUIREMENTS')).toBe(true);
    expect(out).toMatch(/CHARACTER: A 30yo woman/);
    expect(out).toMatch(/SCENE \/ SET: Sunny kitchen\./);
    expect(out).toMatch(/"Hello there\."/);
    expect(out).toMatch(/"How are you\?"/);
  });

  it('reports the actual segment duration in the pacing block', () => {
    const out8 = buildOmniFlashSegmentPrompt({
      characterDescription: 'C',
      sceneDescription: 'S',
      segmentDialogue: '"line"',
      segmentDurationSeconds: 8,
    });
    expect(out8).toMatch(/8-second duration/);
    const out4 = buildOmniFlashSegmentPrompt({
      characterDescription: 'C',
      sceneDescription: 'S',
      segmentDialogue: '"line"',
      segmentDurationSeconds: 4,
    });
    expect(out4).toMatch(/4-second duration/);
  });

  it('emits the CONTINUITY note ONLY when segmentIndexLabel is provided', () => {
    const without = buildOmniFlashSegmentPrompt({
      characterDescription: 'C',
      sceneDescription: 'S',
      segmentDialogue: '"line"',
      segmentDurationSeconds: 10,
    });
    expect(without).not.toMatch(/CONTINUITY/);
    const withLabel = buildOmniFlashSegmentPrompt({
      characterDescription: 'C',
      sceneDescription: 'S',
      segmentDialogue: '"line"',
      segmentDurationSeconds: 10,
      segmentIndexLabel: 'Part 2 of 3',
    });
    expect(withLabel).toMatch(/CONTINUITY/);
    expect(withLabel).toMatch(/Part 2 of 3/);
    expect(withLabel).toMatch(/character must NOT reference this in speech/);
  });

  it('falls back to the natural-ambient hint when no segment dialogue is supplied', () => {
    const out = buildOmniFlashSegmentPrompt({
      characterDescription: 'C',
      sceneDescription: 'S',
      segmentDialogue: '',
      segmentDurationSeconds: 10,
    });
    expect(out).toMatch(/No dialogue — natural ambient sound only/);
  });
});
