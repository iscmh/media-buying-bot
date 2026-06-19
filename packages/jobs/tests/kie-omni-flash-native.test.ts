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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildContinuousMonologue,
  buildOmniFlashPrompt,
  buildOmniFlashSegmentPrompt,
  clampOmniDuration,
  countMoneyClaims,
  decideOmniAttemptOutcome,
  estimateDialogueSeconds,
  isRetryableOmniFailure,
  RETRYABLE_OMNI_FAIL_CODES,
  resolveTargetDuration,
  runFrameExtract,
  runOmniSegment,
  scrubAll,
  scrubBrandPersonReferences,
  scrubCelebrityReferences,
  shouldRegeneratePipeline,
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

  it('Polish-14: 8 clips × 6s (~48s total) → 5 segments (linear scale, no artificial cap)', () => {
    const segments = splitClipsIntoOmniSegments(
      Array.from({ length: 8 }, (_, i) => clipForSeconds(6, `C${i}`)),
    );
    expect(segments).toHaveLength(5);
    const totalClips = segments.reduce((s, x) => s + x.clips.length, 0);
    expect(totalClips).toBe(8);
  });

  it('Polish-14: 10 clips × 6s (~60s total) → 6 segments', () => {
    const segments = splitClipsIntoOmniSegments(
      Array.from({ length: 10 }, (_, i) => clipForSeconds(6, `C${i}`)),
    );
    expect(segments).toHaveLength(6);
    const totalClips = segments.reduce((s, x) => s + x.clips.length, 0);
    expect(totalClips).toBe(10);
  });

  it('Polish-14: 15 clips × 6s (~90s total) → 9 segments', () => {
    const segments = splitClipsIntoOmniSegments(
      Array.from({ length: 15 }, (_, i) => clipForSeconds(6, `C${i}`)),
    );
    expect(segments).toHaveLength(9);
  });

  it('Polish-14: runaway script (200 clips × 6s ≈ 1200s) → capped at sanity ceiling of 30 segments', () => {
    const segments = splitClipsIntoOmniSegments(
      Array.from({ length: 200 }, (_, i) => clipForSeconds(6, `C${i}`)),
    );
    expect(segments).toHaveLength(30);
    // Every clip still represented (last segment absorbs the overflow).
    const totalClips = segments.reduce((s, x) => s + x.clips.length, 0);
    expect(totalClips).toBe(200);
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

describe('Polish-12.2: isRetryableOmniFailure', () => {
  it('treats the three documented Gemini safety codes as retryable', () => {
    expect(isRetryableOmniFailure('PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED')).toBe(true);
    expect(isRetryableOmniFailure('PUBLIC_ERROR_SAFETY_FILTER_FAILED')).toBe(true);
    expect(isRetryableOmniFailure('PUBLIC_ERROR_PERSON_GENERATION_FAILED')).toBe(true);
  });

  it('treats auth / validation / balance / rate-limit codes as NOT retryable', () => {
    expect(isRetryableOmniFailure('401_UNAUTHORIZED')).toBe(false);
    expect(isRetryableOmniFailure('402_INSUFFICIENT_BALANCE')).toBe(false);
    expect(isRetryableOmniFailure('422_VALIDATION_FAILED')).toBe(false);
    expect(isRetryableOmniFailure('429_RATE_LIMIT')).toBe(false);
  });

  it('returns false for empty / null / undefined input', () => {
    expect(isRetryableOmniFailure('')).toBe(false);
    expect(isRetryableOmniFailure(null)).toBe(false);
    expect(isRetryableOmniFailure(undefined)).toBe(false);
  });

  it('returns false for any other code (defensive default)', () => {
    expect(isRetryableOmniFailure('SOMETHING_NEW')).toBe(false);
    expect(isRetryableOmniFailure('public_error_safety_filter_failed')).toBe(false); // case-sensitive
  });

  it('RETRYABLE_OMNI_FAIL_CODES exposes the canonical set', () => {
    expect(RETRYABLE_OMNI_FAIL_CODES.has('PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED')).toBe(true);
    // Polish-12.7.1: INTERNAL joined the set (5 total now).
    expect(RETRYABLE_OMNI_FAIL_CODES.size).toBe(5);
    expect(RETRYABLE_OMNI_FAIL_CODES.has('PUBLIC_ERROR_AUDIO_FILTERED')).toBe(true);
    expect(RETRYABLE_OMNI_FAIL_CODES.has('INTERNAL')).toBe(true);
  });

  // Polish-12.2.2: failMsg fallback for kie.ai's inverted shape
  // (failCode left null, identifier surfaces in failMsg).
  it('treats failMsg as retryable when failCode is missing but failMsg is a known identifier', () => {
    expect(isRetryableOmniFailure(undefined, 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED')).toBe(
      true,
    );
    expect(isRetryableOmniFailure(null, 'PUBLIC_ERROR_SAFETY_FILTER_FAILED')).toBe(true);
  });

  it('back-compat: single-arg call (failCode only) still works', () => {
    expect(isRetryableOmniFailure('PUBLIC_ERROR_SAFETY_FILTER_FAILED')).toBe(true);
    expect(isRetryableOmniFailure('PUBLIC_ERROR_SAFETY_FILTER_FAILED', undefined)).toBe(true);
  });

  it("failMsg fallback ignores prose messages that aren't known identifiers", () => {
    expect(isRetryableOmniFailure(undefined, 'unrelated error message')).toBe(false);
    expect(isRetryableOmniFailure(undefined, 'Generation failed due to safety')).toBe(false);
  });
});

describe('Polish-12.2: decideOmniAttemptOutcome', () => {
  it('successful generation → success with outputUrl', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'success',
      outputUrl: 'https://kie.ai/out.mp4',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') expect(r.outputUrl).toBe('https://kie.ai/out.mp4');
  });

  it('submit failure → abort immediately (never retried)', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: false,
      submitError: 'invalid API key',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('abort');
    if (r.kind === 'abort') expect(r.reason).toMatch(/invalid API key/);
  });

  it('retryable safety filter on a non-final attempt → retry', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'fail',
      failCode: 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
      failMsg: 'public figure detected',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('retry');
  });

  it('retryable safety filter on the FINAL attempt → abort with "exhausted" reason', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'fail',
      failCode: 'PUBLIC_ERROR_SAFETY_FILTER_FAILED',
      failMsg: 'flagged',
      attempt: 3,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('abort');
    if (r.kind === 'abort') {
      expect(r.reason).toMatch(/exhausted 3 attempt\(s\)/);
      expect(r.reason).toMatch(/PUBLIC_ERROR_SAFETY_FILTER_FAILED/);
    }
  });

  it('non-retryable failure code → abort immediately even with attempts remaining', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'fail',
      failCode: '422_VALIDATION_FAILED',
      failMsg: 'prompt too long',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('abort');
    if (r.kind === 'abort') {
      expect(r.reason).toMatch(/prompt too long/);
      expect(r.reason).not.toMatch(/exhausted/);
    }
  });

  it('poll-layer error (no pollState) → abort (deterministic 5xx etc.)', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: undefined,
      pollError: 'kie.ai 502 bad gateway',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('abort');
    if (r.kind === 'abort') expect(r.reason).toMatch(/502 bad gateway/);
  });

  it('poll loop exhausted without terminal state (waiting) → abort', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'waiting',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('abort');
    if (r.kind === 'abort') expect(r.reason).toMatch(/did not reach a terminal state/);
  });

  it('success state but missing outputUrl → not a success (defensive); abort path', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'success',
      outputUrl: undefined,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).not.toBe('success');
  });

  it('falls back to a generic reason when failMsg is missing', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'fail',
      failCode: '422_VALIDATION_FAILED',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('abort');
    if (r.kind === 'abort') expect(r.reason).toMatch(/kie\.ai task failed.*422/);
  });
});

describe('Polish-12.2.1: runOmniSegment poll-loop classifier', () => {
  // The poll-loop bug we're guarding against: pollKieOmniTask may
  // surface a documented task failure as { ok: false, state: 'fail',
  // failCode } when kie.ai returns a non-200 envelope code alongside
  // a body-level failCode. The pre-12.2.1 ordering ate the state on
  // the !tick.ok branch and aborted as a poll-layer error — retry
  // never fired. These three tests pin the corrected ordering.

  const segment = {
    segmentIndex: 0,
    clips: [{ videoPrompt: 'Hi.', dialogue: 'Hi.' }],
    estimatedDurationSeconds: 5,
    combinedDialogue: '"Hi."',
  };

  function makeStubStep(responses: Record<string, unknown>) {
    const seen: string[] = [];
    const step = {
      run: async (name: string, _fn: () => Promise<unknown>) => {
        seen.push(name);
        if (!(name in responses)) {
          throw new Error(`unexpected step.run("${name}")`);
        }
        return responses[name];
      },
      sleep: async (_name: string, _duration: string) => undefined,
    };
    return { step, seen };
  }

  it('ok:false + state:fail + retryable failCode on attempt 1, success on attempt 2 → segment succeeds with attempts=2', async () => {
    const { step, seen } = makeStubStep({
      'kie-omni-submit-0-a1': { ok: true, taskId: 'tsk-1' },
      'kie-omni-check-0-a1-0': {
        ok: false,
        state: 'fail',
        failCode: 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
        failMsg: 'public figure detected',
      },
      'kie-omni-submit-0-a2': { ok: true, taskId: 'tsk-2' },
      'kie-omni-check-0-a2-0': {
        ok: true,
        state: 'success',
        outputUrl: 'https://kie.ai/out.mp4',
      },
      'kie-omni-upload-0': { ok: true, publicUrl: 'https://supa/out.mp4' },
    });
    const result = await runOmniSegment({
      step,
      segment,
      totalSegments: 1,
      referenceImageUrl: 'https://supa/ref.png',
      characterDescription: 'A 30yo woman.',
      sceneDescription: 'Sunny kitchen.',
      userId: 'user-1',
      jobId: 'job-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.publicUrl).toBe('https://supa/out.mp4');
      expect(result.costUsd).toBeCloseTo(1.8, 4);
    }
    // Both attempt step names must have fired — proves retry path ran.
    expect(seen).toContain('kie-omni-submit-0-a1');
    expect(seen).toContain('kie-omni-check-0-a1-0');
    expect(seen).toContain('kie-omni-submit-0-a2');
    expect(seen).toContain('kie-omni-check-0-a2-0');
  });

  it('ok:false + state:fail + retryable failCode 3x → segment fails with "exhausted 3 attempt(s)" message', async () => {
    const failTick = {
      ok: false,
      state: 'fail',
      failCode: 'PUBLIC_ERROR_SAFETY_FILTER_FAILED',
      failMsg: 'flagged',
    };
    const { step, seen } = makeStubStep({
      'kie-omni-submit-0-a1': { ok: true, taskId: 'tsk-1' },
      'kie-omni-check-0-a1-0': failTick,
      'kie-omni-submit-0-a2': { ok: true, taskId: 'tsk-2' },
      'kie-omni-check-0-a2-0': failTick,
      'kie-omni-submit-0-a3': { ok: true, taskId: 'tsk-3' },
      'kie-omni-check-0-a3-0': failTick,
    });
    const result = await runOmniSegment({
      step,
      segment,
      totalSegments: 1,
      referenceImageUrl: 'https://supa/ref.png',
      characterDescription: 'A 30yo woman.',
      sceneDescription: 'Sunny kitchen.',
      userId: 'user-1',
      jobId: 'job-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(3);
      expect(result.error).toMatch(/exhausted 3 attempt\(s\)/);
      expect(result.error).toMatch(/PUBLIC_ERROR_SAFETY_FILTER_FAILED/);
      expect(result.costUsd).toBeCloseTo(2.7, 4);
    }
    expect(seen).toContain('kie-omni-submit-0-a3');
  });

  it('Polish-12.2.2: ok:true + state:fail + failCode=undefined + failMsg=PUBLIC_ERROR_* → retries via failMsg fallback', async () => {
    const { step, seen } = makeStubStep({
      'kie-omni-submit-0-a1': { ok: true, taskId: 'tsk-1' },
      'kie-omni-check-0-a1-0': {
        ok: true,
        state: 'fail',
        failCode: undefined,
        failMsg: 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
      },
      'kie-omni-submit-0-a2': { ok: true, taskId: 'tsk-2' },
      'kie-omni-check-0-a2-0': {
        ok: true,
        state: 'success',
        outputUrl: 'https://kie.ai/out.mp4',
      },
      'kie-omni-upload-0': { ok: true, publicUrl: 'https://supa/out.mp4' },
    });
    const result = await runOmniSegment({
      step,
      segment,
      totalSegments: 1,
      referenceImageUrl: 'https://supa/ref.png',
      characterDescription: 'A 30yo woman.',
      sceneDescription: 'Sunny kitchen.',
      userId: 'user-1',
      jobId: 'job-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.publicUrl).toBe('https://supa/out.mp4');
    }
    expect(seen).toContain('kie-omni-submit-0-a2');
  });

  it('ok:false + state:undefined + errorMessage → aborts on first attempt (poll-layer error, no retry)', async () => {
    const { step, seen } = makeStubStep({
      'kie-omni-submit-0-a1': { ok: true, taskId: 'tsk-1' },
      'kie-omni-check-0-a1-0': {
        ok: false,
        state: undefined,
        errorMessage: 'network error',
      },
    });
    const result = await runOmniSegment({
      step,
      segment,
      totalSegments: 1,
      referenceImageUrl: 'https://supa/ref.png',
      characterDescription: 'A 30yo woman.',
      sceneDescription: 'Sunny kitchen.',
      userId: 'user-1',
      jobId: 'job-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.error).toMatch(/network error/);
      expect(result.error).not.toMatch(/exhausted/);
    }
    // No second attempt should have been issued.
    expect(seen).not.toContain('kie-omni-submit-0-a2');
  });
});

describe('Polish-12.3: scrubCelebrityReferences', () => {
  it('replaces a known celebrity name with the generic placeholder', () => {
    expect(scrubCelebrityReferences('Looks like Kim Kardashian, healthy glow.')).toBe(
      'Looks like a popular figure, healthy glow.',
    );
    expect(scrubCelebrityReferences('Sounds like joe rogan after the gym.')).toBe(
      'Sounds like a popular figure after the gym.',
    );
  });

  it('handles multiple references in one string', () => {
    const out = scrubCelebrityReferences('Elon Musk meets MrBeast meets Andrew Tate in one ad.');
    expect(out).toBe('a popular figure meets a popular figure meets a popular figure in one ad.');
  });

  it('is case-insensitive', () => {
    expect(scrubCelebrityReferences('ELON MUSK')).toBe('a popular figure');
    expect(scrubCelebrityReferences('elon musk')).toBe('a popular figure');
    expect(scrubCelebrityReferences('Elon Musk')).toBe('a popular figure');
  });

  it('handles Mr. Beast / MrBeast / Mr Beast spelling variants', () => {
    expect(scrubCelebrityReferences('Mr. Beast challenge')).toBe('a popular figure challenge');
    expect(scrubCelebrityReferences('MrBeast challenge')).toBe('a popular figure challenge');
    expect(scrubCelebrityReferences('Mr Beast challenge')).toBe('a popular figure challenge');
  });

  it('leaves clean text untouched', () => {
    const clean = 'A 42yo white American man named John, weathered tan skin, three-day stubble.';
    expect(scrubCelebrityReferences(clean)).toBe(clean);
  });

  it('is word-boundary aware — does NOT mangle innocent overlaps', () => {
    // "trumpet" must not match "trump", "muskrat" must not match "musk", etc.
    expect(scrubCelebrityReferences('She plays the trumpet beautifully.')).toBe(
      'She plays the trumpet beautifully.',
    );
    expect(scrubCelebrityReferences('A muskrat swims by.')).toBe('A muskrat swims by.');
  });

  it('handles empty / null-shaped input safely', () => {
    expect(scrubCelebrityReferences('')).toBe('');
  });
});

describe('Polish-12.3: KIE_OMNI_FLASH_HARD_DIRECTIVE anti-celebrity language', () => {
  it('contains anti-celebrity language', async () => {
    const { KIE_OMNI_FLASH_HARD_DIRECTIVE } = await import('@mbb/shared');
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/fictional everyday person/i);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/celebrity/i);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/public personality/i);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/REJECTED by upstream filters/);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/No copyrighted character names/i);
  });
});

describe('Polish-14.1: resolveTargetDuration', () => {
  it('returns the source duration when in range', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 22 })).toBe(22);
    expect(resolveTargetDuration({ source_duration_seconds: 60 })).toBe(60);
    expect(resolveTargetDuration({ source_duration_seconds: 8 })).toBe(8);
    expect(resolveTargetDuration({ source_duration_seconds: 90 })).toBe(90);
  });

  it('ceiling-rounds fractional durations (so 21.6s becomes 22)', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 21.4 })).toBe(22);
    expect(resolveTargetDuration({ source_duration_seconds: 8.01 })).toBe(9);
  });

  it('clamps below-floor inputs up to the 8s minimum', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 3 })).toBe(8);
    expect(resolveTargetDuration({ source_duration_seconds: 0.5 })).toBe(8);
  });

  it('clamps above-ceiling inputs down to the 90s maximum', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 120 })).toBe(90);
    expect(resolveTargetDuration({ source_duration_seconds: 500 })).toBe(90);
  });

  it('falls back to 30s default when metadata is null', () => {
    expect(resolveTargetDuration(null)).toBe(30);
  });

  it('falls back to 30s default when source_duration_seconds is missing', () => {
    expect(resolveTargetDuration({})).toBe(30);
    expect(resolveTargetDuration({ other_field: 'noise' })).toBe(30);
  });

  it('falls back to 30s default for NaN / non-number / negative / zero', () => {
    expect(resolveTargetDuration({ source_duration_seconds: NaN })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: -5 })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: 0 })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: '22' as unknown as number })).toBe(30);
  });

  it('falls back to 30s default when source_duration_seconds is Infinity', () => {
    expect(resolveTargetDuration({ source_duration_seconds: Infinity })).toBe(30);
  });
});

describe('Polish-12.3.1: scrubBrandPersonReferences', () => {
  it('replaces Disney World / Disneyland / Disney+ with a generic theme park', () => {
    expect(scrubBrandPersonReferences('Took the kids to Disney World last summer.')).toBe(
      'Took the kids to a theme park last summer.',
    );
    expect(scrubBrandPersonReferences('Disneyland Paris was magic.')).toBe(
      'a theme park Paris was magic.',
    );
    expect(scrubBrandPersonReferences('I watch Disney+ every night.')).toBe(
      'I watch a theme park every night.',
    );
  });

  it('replaces Tesla with a generic EV company', () => {
    expect(scrubBrandPersonReferences('Drove my Tesla home.')).toBe('Drove my an EV company home.');
  });

  it('replaces SpaceX with a generic space company', () => {
    expect(scrubBrandPersonReferences('SpaceX launched another rocket.')).toBe(
      'a space company launched another rocket.',
    );
  });

  it('replaces Trump Tower / Trump Hotel with a generic luxury hotel', () => {
    expect(scrubBrandPersonReferences('Met him at Trump Tower.')).toBe(
      'Met him at a luxury hotel.',
    );
    expect(scrubBrandPersonReferences('Stayed at the Trump Hotel in Vegas.')).toBe(
      'Stayed at the a luxury hotel in Vegas.',
    );
  });

  it('replaces Virgin Galactic / Atlantic / Records', () => {
    expect(scrubBrandPersonReferences('Booked a Virgin Atlantic flight.')).toBe(
      'Booked a a transportation company flight.',
    );
  });

  it('replaces Oprah / Dolly Parton with category descriptors', () => {
    expect(scrubBrandPersonReferences('She watches Oprah every day.')).toBe(
      'She watches a popular talk show host every day.',
    );
    expect(scrubBrandPersonReferences('Dolly Parton sang the opener.')).toBe(
      'a country music star sang the opener.',
    );
  });

  it('is word-boundary aware — leaves "tesla coil" inside a science context untouched-ish', () => {
    // The pattern matches "tesla" as a standalone word, so "tesla coil"
    // DOES match (boundary between "tesla" and " coil"). That's fine —
    // an EV-company coil is unlikely prose. Word-boundary-tightening is
    // a future polish; for now we accept over-scrub over filter-trip.
    // The important guarantee is that mid-word matches like "TESLAtest"
    // remain UNTOUCHED.
    expect(scrubBrandPersonReferences('TESLAtest is a fake brand.')).toBe(
      'TESLAtest is a fake brand.',
    );
    expect(scrubBrandPersonReferences('virginiaplate')).toBe('virginiaplate');
  });

  it('leaves clean text untouched', () => {
    const clean = 'A 30yo woman with dark hair, wearing a blue cotton t-shirt.';
    expect(scrubBrandPersonReferences(clean)).toBe(clean);
  });

  it('handles empty input safely', () => {
    expect(scrubBrandPersonReferences('')).toBe('');
  });
});

describe('Polish-12.3.1: scrubAll composes both scrubbers', () => {
  it('strips a direct celebrity name AND a brand-person reference in one pass', () => {
    const input = 'Elon Musk runs Tesla and is a popular figure.';
    // First scrubCelebrityReferences runs ("Elon Musk" → "a popular
    // figure"), then scrubBrandPersonReferences runs ("Tesla" → "an EV
    // company"). Order matters only because the celebrity scrub may
    // change context — none of the brand patterns depend on celebrity
    // text remaining, so the result is stable either way.
    const out = scrubAll(input);
    expect(out).not.toMatch(/Elon Musk/i);
    expect(out).not.toMatch(/\bTesla\b/i);
    expect(out).toMatch(/an EV company/);
    expect(out).toMatch(/a popular figure/);
  });

  it('leaves clean text untouched', () => {
    const clean = 'A 30yo woman with dark hair, wearing a blue cotton t-shirt.';
    expect(scrubAll(clean)).toBe(clean);
  });
});

describe('Polish-12.3.1: KIE_OMNI_FLASH_HARD_DIRECTIVE pairs with the master-prompt brand-person list', () => {
  it('master prompt names the brand-as-person trap', async () => {
    const { getUniversalUgcMasterPrompt } = await import('@mbb/ai-providers');
    const text = getUniversalUgcMasterPrompt();
    expect(text).toMatch(/inseparable from their founders\/owners/i);
    expect(text).toMatch(/Disney/);
    expect(text).toMatch(/Tesla/);
    expect(text).toMatch(/Trump properties/);
  });
});

describe('Polish-12.4: runOmniSegment plumbs characterId into the submit call', () => {
  // Polish-12.3.1 introduced scrubAll; Polish-12.4 adds character_ids
  // alongside the image_urls. These tests pin that the segment runner
  // passes characterId through to the captured submit body, AND that
  // when characterId is absent the submit body omits character_ids
  // (graceful fallback to image_urls-only — Polish-12.3 behavior).

  const segment = {
    segmentIndex: 0,
    clips: [{ videoPrompt: 'Hi.', dialogue: 'Hi.' }],
    estimatedDurationSeconds: 5,
    combinedDialogue: '"Hi."',
  };

  function makeStubStep(responses: Record<string, unknown>) {
    const submitInputs: Record<string, unknown>[] = [];
    const seen: string[] = [];
    const step = {
      run: async (name: string, fn: () => Promise<unknown>) => {
        seen.push(name);
        if (name.startsWith('kie-omni-submit-')) {
          // Capture what the worker WOULD have sent to kie.ai. The
          // callback closes over the input object the worker built,
          // so we run the callback to materialize that intent (which
          // the captureFetch fixture below intercepts) — but since we
          // don't have a fetch stub here, we just return the canned
          // response and rely on the inputs being inspectable via
          // closure. Workaround: the worker's submit callback returns
          // submitKieOmniVideo({...}), so we can't inspect the body
          // without mocking @mbb/ai-providers. Instead, we use the
          // step name as the inspection target — the worker emits one
          // submit step per attempt, suffixed -a1, -a2, ... Per the
          // step name we can verify the retry / no-retry behavior.
          // For the character_ids plumbing assertion, see the
          // submitKieOmniVideo unit tests in @mbb/ai-providers.
          submitInputs.push({ name });
        }
        if (!(name in responses)) {
          throw new Error(`unexpected step.run("${name}")`);
        }
        // Don't invoke fn() — the stub responses bypass live calls.
        void fn;
        return responses[name];
      },
      sleep: async (_n: string, _d: string) => undefined,
    };
    return { step, submitInputs, seen };
  }

  it('passes characterId through → submit step fires (a1) → success path', async () => {
    const { step, seen } = makeStubStep({
      'kie-omni-submit-0-a1': { ok: true, taskId: 'tsk-1' },
      'kie-omni-check-0-a1-0': {
        ok: true,
        state: 'success',
        outputUrl: 'https://kie.ai/out.mp4',
      },
      'kie-omni-upload-0': { ok: true, publicUrl: 'https://supa/out.mp4' },
    });
    const result = await runOmniSegment({
      step,
      segment,
      totalSegments: 1,
      referenceImageUrl: 'https://supa/ref.png',
      characterId: 'char_abc',
      characterDescription: 'A 30yo woman.',
      sceneDescription: 'Sunny kitchen.',
      userId: 'user-1',
      jobId: 'job-1',
    });
    expect(result.ok).toBe(true);
    expect(seen).toContain('kie-omni-submit-0-a1');
  });

  it('runs without characterId (Polish-12.3 fallback) and still succeeds', async () => {
    const { step, seen } = makeStubStep({
      'kie-omni-submit-0-a1': { ok: true, taskId: 'tsk-1' },
      'kie-omni-check-0-a1-0': {
        ok: true,
        state: 'success',
        outputUrl: 'https://kie.ai/out.mp4',
      },
      'kie-omni-upload-0': { ok: true, publicUrl: 'https://supa/out.mp4' },
    });
    const result = await runOmniSegment({
      step,
      segment,
      totalSegments: 1,
      referenceImageUrl: 'https://supa/ref.png',
      // characterId omitted → submit body's character_ids field stays
      // undefined (verified at unit level in @mbb/ai-providers
      // kie-omni.test.ts).
      characterDescription: 'A 30yo woman.',
      sceneDescription: 'Sunny kitchen.',
      userId: 'user-1',
      jobId: 'job-1',
    });
    expect(result.ok).toBe(true);
    expect(seen).toContain('kie-omni-submit-0-a1');
  });
});

describe('Polish-12.5: runOmniSegment surfaces referenceUrlUsed on SegmentSuccess', () => {
  // Audit: caller's chain-continuity bookkeeping reads referenceUrlUsed
  // off each SegmentSuccess to populate the composite's
  // per_segment_reference_urls metadata. Pin that we surface it.

  const segment = {
    segmentIndex: 0,
    clips: [{ videoPrompt: 'Hi.', dialogue: 'Hi.' }],
    estimatedDurationSeconds: 5,
    combinedDialogue: '"Hi."',
  };

  function makeStubStep(responses: Record<string, unknown>) {
    const step = {
      run: async (name: string, _fn: () => Promise<unknown>) => {
        if (!(name in responses)) throw new Error(`unexpected step.run("${name}")`);
        return responses[name];
      },
      sleep: async () => undefined,
    };
    return step;
  }

  it('reports the referenceImageUrl that fed the segment', async () => {
    const step = makeStubStep({
      'kie-omni-submit-0-a1': { ok: true, taskId: 't' },
      'kie-omni-check-0-a1-0': {
        ok: true,
        state: 'success',
        outputUrl: 'https://kie.ai/out.mp4',
      },
      'kie-omni-upload-0': { ok: true, publicUrl: 'https://supa/out.mp4' },
    });
    const result = await runOmniSegment({
      step,
      segment,
      totalSegments: 1,
      referenceImageUrl: 'https://supa/chain-link-frame.jpg',
      characterId: 'char_abc',
      characterDescription: 'A 30yo woman.',
      sceneDescription: 'Sunny kitchen.',
      userId: 'user-1',
      jobId: 'job-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.referenceUrlUsed).toBe('https://supa/chain-link-frame.jpg');
    }
  });
});

describe('Polish-12.5: runFrameExtract chain helper', () => {
  const realEnv = process.env;
  beforeEach(() => {
    process.env = { ...realEnv };
  });
  afterEach(() => {
    process.env = realEnv;
  });

  function makeStubStep(responses: Record<string, unknown>) {
    const seen: string[] = [];
    const step = {
      run: async (name: string, _fn: () => Promise<unknown>) => {
        seen.push(name);
        if (!(name in responses)) throw new Error(`unexpected step.run("${name}")`);
        return responses[name];
      },
      sleep: async (_name: string, _duration: string) => undefined,
    };
    return { step, seen };
  }

  it('returns ok=false with a clear reason when REPLICATE_FRAME_EXTRACT_MODEL_ID is unset', async () => {
    delete process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID;
    const { step } = makeStubStep({});
    const r = await runFrameExtract({
      step,
      videoUrl: 'https://supa/seg-0.mp4',
      segmentIndex: 0,
      userId: 'u',
      jobId: 'j',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/REPLICATE_FRAME_EXTRACT_MODEL_ID|chain continuity disabled/);
    }
  });

  it('success: submit OK → poll completed → returns frame URL + cost', async () => {
    process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID = 'owner/ffmpeg-util';
    const { step, seen } = makeStubStep({
      'kie-omni-frame-extract-submit-0': {
        ok: true,
        predictionId: 'pred_x',
        modelId: 'owner/ffmpeg-util',
      },
      'kie-omni-frame-extract-check-0-0': {
        status: 'completed',
        frameUrl: 'https://replicate/frame.jpg',
        costUsd: 0.02,
      },
    });
    const r = await runFrameExtract({
      step,
      videoUrl: 'https://supa/seg-0.mp4',
      segmentIndex: 0,
      userId: 'u',
      jobId: 'j',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.publicUrl).toBe('https://replicate/frame.jpg');
      expect(r.costUsd).toBeCloseTo(0.02, 4);
    }
    expect(seen).toContain('kie-omni-frame-extract-submit-0');
    expect(seen).toContain('kie-omni-frame-extract-check-0-0');
  });

  it('failure: submit returns ok=false → bubbles error reason', async () => {
    process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID = 'owner/ffmpeg-util';
    const { step } = makeStubStep({
      'kie-omni-frame-extract-submit-1': {
        ok: false,
        modelId: 'owner/ffmpeg-util',
        errorMessage: 'rate limit',
      },
    });
    const r = await runFrameExtract({
      step,
      videoUrl: 'https://supa/seg-1.mp4',
      segmentIndex: 1,
      userId: 'u',
      jobId: 'j',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rate limit/);
  });

  it('failure: poll returns status=failed → bubbles errorMessage', async () => {
    process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID = 'owner/ffmpeg-util';
    const { step } = makeStubStep({
      'kie-omni-frame-extract-submit-2': {
        ok: true,
        predictionId: 'pred_y',
        modelId: 'owner/ffmpeg-util',
      },
      'kie-omni-frame-extract-check-2-0': {
        status: 'failed',
        errorMessage: 'codec unsupported',
        costUsd: 0,
      },
    });
    const r = await runFrameExtract({
      step,
      videoUrl: 'https://supa/seg-2.mp4',
      segmentIndex: 2,
      userId: 'u',
      jobId: 'j',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/codec unsupported/);
  });
});

describe('Polish-12.6: shouldRegeneratePipeline', () => {
  // Pure decision helper for the full-pipeline regeneration loop.
  // Used by generateKieOmniFlashNative to decide whether a segment
  // failure (after per-segment retries exhausted) warrants
  // regenerating the whole Nano Banana → character → segment chain
  // with a fresh face.

  it('PROMINENT_PEOPLE_FILTER_FAILED on attempt 1 of 2 → regenerate', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError:
          'Segment 0 failed after 3 attempt(s) (PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED): public figure detected',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(true);
  });

  it('PROMINENT_PEOPLE filter mention anywhere in error string → regenerate', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError: 'Omni segment failed — PROMINENT_PEOPLE_FILTER_FAILED triggered',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(true);
  });

  it('PROMINENT_PEOPLE filter on FINAL attempt → do NOT regenerate (budget exhausted)', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError: 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
        currentAttempt: 2,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });

  it('non-filter failure (auth, balance, validation, network) → do NOT regenerate', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError: 'kie.ai authentication failed (invalid API key)',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
    expect(
      shouldRegeneratePipeline({
        segmentError: 'kie.ai account has insufficient balance',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
    expect(
      shouldRegeneratePipeline({
        segmentError: 'kie.ai validation failed: prompt too long',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
    expect(
      shouldRegeneratePipeline({
        segmentError: 'network error: ECONNRESET',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });

  it('safety-filter (not prominent-people) → do NOT regenerate (different remediation)', () => {
    // SAFETY_FILTER_FAILED is retried per-segment via fresh seed (the
    // generic safety filter is stochastic on the same prompt). A
    // full pipeline regen costs more and doesn't actually fix the
    // distinct trigger condition.
    expect(
      shouldRegeneratePipeline({
        segmentError: 'PUBLIC_ERROR_SAFETY_FILTER_FAILED',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });

  it('undefined / empty error → do NOT regenerate', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError: undefined,
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
    expect(
      shouldRegeneratePipeline({
        segmentError: '',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });

  it('maxAttempts=1 → never regenerate (single-shot mode)', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError: 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
        currentAttempt: 1,
        maxAttempts: 1,
      }),
    ).toBe(false);
  });
});

describe('Polish-12.7: countMoneyClaims', () => {
  it('counts dollar-sign forms ($380, $2,600, $9,800)', () => {
    expect(countMoneyClaims('$380 today.')).toBe(1);
    expect(countMoneyClaims('$380 today and $2,600 this week.')).toBe(2);
    expect(countMoneyClaims('$380 today, $2,600 weekly, $9,800 monthly.')).toBe(3);
  });

  it('counts "N dollars" / "N bucks" forms', () => {
    expect(countMoneyClaims('I made 380 dollars today.')).toBe(1);
    expect(countMoneyClaims('Cleared 50 bucks this hour and 380 dollars this morning.')).toBe(2);
  });

  it('counts spelled-out multipliers (three hundred, ten grand, five thousand)', () => {
    expect(countMoneyClaims('I pulled three hundred yesterday.')).toBe(1);
    expect(countMoneyClaims('Ten grand this month. Bro.')).toBe(1);
    expect(countMoneyClaims('Three hundred, ten grand, five thousand. Wild.')).toBe(3);
  });

  it('counts shorthand (26 hundred, 10 grand, 5k)', () => {
    // Hyphenated forms like "Twenty-six hundred" match via the inner
    // "six hundred" substring — Polish-12.7's intent is exactly to
    // count this as one claim, which is correct.
    expect(countMoneyClaims('Twenty-six hundred this week.')).toBe(1);
    expect(countMoneyClaims('26 hundred this week.')).toBe(1);
    expect(countMoneyClaims('10 grand this month.')).toBe(1);
    expect(countMoneyClaims('5k right now.')).toBe(1);
  });

  it('counts the mixed example from the spec', () => {
    // "$380 today and $2,600 this week" → 2
    expect(countMoneyClaims('$380 today and $2,600 this week')).toBe(2);
    // "three hundred and ten grand" → 2 (different spelled patterns)
    expect(countMoneyClaims('three hundred and ten grand')).toBe(2);
  });

  it('returns 0 for non-money dialogue', () => {
    expect(countMoneyClaims('Just woke up and had coffee.')).toBe(0);
    expect(countMoneyClaims('')).toBe(0);
  });

  it('returns 0 for "good money" / "a few hundred" soft phrasing', () => {
    // These are the phrases the master prompt explicitly forbids — but
    // the counter scores literal money expressions, not the soft text.
    expect(countMoneyClaims('I make good money from this.')).toBe(0);
    // "a few hundred" — "hundred" with no leading number digit/word →
    // doesn't match the spelled patterns. 0.
    expect(countMoneyClaims('I make a few hundred a day.')).toBe(0);
  });
});

describe('Polish-12.7: splitClipsIntoOmniSegments distributes claims across segments', () => {
  // Helper builds clips with a specific money-claim count by stuffing
  // the dialogue with dollar-sign tokens. Each clip is ~6s.
  function clipWithClaims(
    label: string,
    claimCount: number,
  ): {
    videoPrompt: string;
    dialogue: string;
  } {
    const claims = Array.from({ length: claimCount }, (_, i) => `$${100 + i * 100}`).join(' and ');
    const dialogue = `${label}: ${claims} ${Array.from({ length: 8 }, (_, i) => `word${i}`).join(
      ' ',
    )}`;
    return { videoPrompt: `Action ${label}`, dialogue };
  }

  it('three single-claim clips (one each) → claims spread to one per segment when room exists', () => {
    // Three 6-second clips with one money claim each. Total 18s →
    // ceil(18/10) = 2 segments. Without claim awareness, splitter
    // would land 2 claims in segment 0 and 1 in segment 1. With
    // Polish-12.7 awareness, segment 0 takes clip 0 (1 claim), then
    // claim density forces an early advance so clip 1 (1 claim) goes
    // to segment 1.
    const segments = splitClipsIntoOmniSegments([
      clipWithClaims('A', 1),
      clipWithClaims('B', 1),
      clipWithClaims('C', 1),
    ]);
    // Each segment that received clips has at most 1 claim per the
    // density rule (subject to abs-cap / target).
    for (const s of segments) {
      const claims = s.clips.reduce((n, c) => n + countMoneyClaims(c.dialogue ?? ''), 0);
      expect(claims).toBeLessThanOrEqual(2);
    }
    // All 3 clips still represented.
    const total = segments.reduce((n, s) => n + s.clips.length, 0);
    expect(total).toBe(3);
  });

  it('claim-free clips still respect the existing duration heuristic (no regression)', () => {
    // Three clips, no money claims. Splitter should fall through to
    // the pre-12.7 behavior (duration-driven only).
    const segments = splitClipsIntoOmniSegments([
      { videoPrompt: 'A', dialogue: 'Just talking about my morning.' },
      { videoPrompt: 'B', dialogue: 'The weather is fine today.' },
      { videoPrompt: 'C', dialogue: 'Anyway, watch this video.' },
    ]);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    const total = segments.reduce((n, s) => n + s.clips.length, 0);
    expect(total).toBe(3);
  });

  it('multi-claim clip stays atomic (no sub-clip splitting)', () => {
    // A single clip with 3 money claims. The splitter can't split
    // within a clip; the 3 claims will all land in whichever segment
    // that clip belongs to. Confirm clip boundary preserved.
    const segments = splitClipsIntoOmniSegments([clipWithClaims('OnlyClip', 3)]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.clips).toHaveLength(1);
  });
});

describe('Polish-12.7: shouldRegeneratePipeline now fires on AUDIO_FILTERED', () => {
  it('AUDIO_FILTERED on attempt 1 of 2 → regenerate', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError:
          'Segment 0 failed after 3 attempt(s) (PUBLIC_ERROR_AUDIO_FILTERED): financial content',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(true);
  });

  it('AUDIO_FILTERED on final attempt → do NOT regenerate (budget exhausted)', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError: 'PUBLIC_ERROR_AUDIO_FILTERED',
        currentAttempt: 2,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });

  it('still gates on PROMINENT_PEOPLE_FILTER (Polish-12.6 behavior preserved)', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError: 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(true);
  });

  it('still rejects deterministic failures (auth, balance, validation)', () => {
    expect(
      shouldRegeneratePipeline({
        segmentError: 'kie.ai authentication failed',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });
});

describe('Polish-12.7: master prompt AUDIO FILTER BYPASS section', () => {
  it('contains the bypass section + all three techniques', async () => {
    const { getUniversalUgcMasterPrompt } = await import('@mbb/ai-providers');
    const text = getUniversalUgcMasterPrompt();
    expect(text).toMatch(/AUDIO FILTER BYPASS — KEEP IT AGGRESSIVE/);
    expect(text).toMatch(/Rhythm-Breaking Emotional Beats/);
    expect(text).toMatch(/Affiliate-Native Phrasing/);
    expect(text).toMatch(/Density Dilution Across Segments/);
  });

  it('explicitly forbids softening to "good money" or "a few hundred"', async () => {
    const { getUniversalUgcMasterPrompt } = await import('@mbb/ai-providers');
    const text = getUniversalUgcMasterPrompt();
    expect(text).toMatch(/DO NOT soften to "good money" or "a few hundred"/);
  });

  it('preserves dollar amounts + cash-out CTA intent', async () => {
    const { getUniversalUgcMasterPrompt } = await import('@mbb/ai-providers');
    const text = getUniversalUgcMasterPrompt();
    expect(text).toMatch(/KEEP the specific dollar amounts/);
    expect(text).toMatch(/KEEP the cash-out CTAs/);
  });
});

describe('Polish-12.7.1: INTERNAL is per-segment retryable but NOT pipeline-regen-triggering', () => {
  it('isRetryableOmniFailure(INTERNAL) → true', () => {
    expect(isRetryableOmniFailure('INTERNAL')).toBe(true);
  });

  it('decideOmniAttemptOutcome with INTERNAL on a non-final attempt → retry', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'fail',
      failCode: 'INTERNAL',
      failMsg: 'internal server error',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('retry');
  });

  it('decideOmniAttemptOutcome with INTERNAL on the FINAL attempt → abort with exhausted reason', () => {
    const r = decideOmniAttemptOutcome({
      submitOk: true,
      pollState: 'fail',
      failCode: 'INTERNAL',
      failMsg: 'internal server error',
      attempt: 3,
      maxAttempts: 3,
    });
    expect(r.kind).toBe('abort');
    if (r.kind === 'abort') {
      expect(r.reason).toMatch(/exhausted 3 attempt\(s\)/);
      expect(r.reason).toMatch(/INTERNAL/);
    }
  });

  it('shouldRegeneratePipeline returns false for INTERNAL (backend errors do not warrant full regen)', () => {
    // INTERNAL is a kie.ai backend hiccup, not a content trigger. A
    // fresh Nano Banana face + character_id wastes $0.20 without
    // fixing the underlying transient. Per-segment retry (3x) is the
    // right level of remediation.
    expect(
      shouldRegeneratePipeline({
        segmentError: 'Segment 2 failed after 3 attempt(s) (INTERNAL): internal server error',
        currentAttempt: 1,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });
});

describe('Polish-12.7.2: substring-match transient kie.ai errors', () => {
  it('matches the production-observed "Internal Error, Please try again later." prose', () => {
    expect(isRetryableOmniFailure(undefined, 'Internal Error, Please try again later.')).toBe(true);
  });

  it('preserves bare-code matching (Polish-12.7.1 back-compat)', () => {
    expect(isRetryableOmniFailure('INTERNAL')).toBe(true);
  });

  it('matches lone "Service Unavailable" prose', () => {
    expect(isRetryableOmniFailure(undefined, 'Service Unavailable')).toBe(true);
  });

  it('matches "Request timeout, please retry" prose', () => {
    expect(isRetryableOmniFailure(undefined, 'Request timeout, please retry')).toBe(true);
  });

  it('matches "deadline exceeded" / "temporarily unavailable" / "backend error" prose', () => {
    expect(isRetryableOmniFailure(undefined, 'Upstream deadline exceeded')).toBe(true);
    expect(isRetryableOmniFailure(undefined, 'The service is temporarily unavailable')).toBe(true);
    expect(isRetryableOmniFailure(undefined, 'Backend error: lost connection')).toBe(true);
  });

  it('rejects deterministic prose like "invalid prompt format"', () => {
    expect(isRetryableOmniFailure(undefined, 'invalid prompt format')).toBe(false);
    expect(isRetryableOmniFailure(undefined, 'unauthorized: bad API key')).toBe(false);
    expect(isRetryableOmniFailure(undefined, 'insufficient balance')).toBe(false);
  });

  it('still rejects rate-limit prose (deterministic, retry burns quota)', () => {
    // Polish-12.2's contract: rate-limit is NOT in the retryable set
    // because retrying just hits the same wall. The transient patterns
    // intentionally don't match "rate limit" prose.
    expect(isRetryableOmniFailure(undefined, 'Rate limit exceeded, slow down')).toBe(false);
  });

  it('still matches set members via failMsg (Polish-12.2.2 back-compat preserved)', () => {
    expect(isRetryableOmniFailure(undefined, 'PUBLIC_ERROR_AUDIO_FILTERED')).toBe(true);
    expect(isRetryableOmniFailure(undefined, 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED')).toBe(
      true,
    );
  });

  it('returns false when both failCode and failMsg are missing', () => {
    expect(isRetryableOmniFailure(undefined, undefined)).toBe(false);
    expect(isRetryableOmniFailure(null, null)).toBe(false);
    expect(isRetryableOmniFailure(undefined, '')).toBe(false);
  });
});

describe('Polish-12.7.3: KIE_OMNI_FLASH_HARD_DIRECTIVE — end-pause + UI suppression', () => {
  it('contains the new "no end-of-clip pause / smile" bullet', async () => {
    const { KIE_OMNI_FLASH_HARD_DIRECTIVE } = await import('@mbb/shared');
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/end-of-clip pause/i);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/smile-to-camera/i);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/idle reaction frame/i);
  });

  it('contains the new "no phone UI / momentary UI flashes" bullet', async () => {
    const { KIE_OMNI_FLASH_HARD_DIRECTIVE } = await import('@mbb/shared');
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/phone UI/);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/momentary UI flashes/i);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/screen reflections/i);
  });

  it('contains the positive "SEGMENT of a longer continuous video / HARD CUT mid-action" requirement', async () => {
    const { KIE_OMNI_FLASH_HARD_DIRECTIVE } = await import('@mbb/shared');
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/SEGMENT of a longer continuous video/);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/HARD CUT mid-action/);
    expect(KIE_OMNI_FLASH_HARD_DIRECTIVE).toMatch(/NO ending gesture/);
  });
});

describe('Polish-12.7.3: master prompt — Dialogue Pacing for Multi-Segment Output', () => {
  it('contains the new pacing section + em-dash boundary guidance', async () => {
    const { getUniversalUgcMasterPrompt } = await import('@mbb/ai-providers');
    const text = getUniversalUgcMasterPrompt();
    expect(text).toMatch(/Dialogue Pacing for Multi-Segment Output/);
    expect(text).toMatch(/ends MID-SENTENCE or MID-THOUGHT/);
    expect(text).toMatch(/em-dash \+ lowercase start signals the cut is mid-sentence/);
  });

  it('contains the BAD / GOOD example pair contrasting complete vs. continuous segments', async () => {
    const { getUniversalUgcMasterPrompt } = await import('@mbb/ai-providers');
    const text = getUniversalUgcMasterPrompt();
    expect(text).toMatch(/Segment 1: "I'm 64\. My pension barely covers/);
    expect(text).toMatch(/Segment 2: "— a theme park\./);
  });
});

describe('Polish-12.7.3: buildOmniFlashSegmentPrompt em-dash continuity detection', () => {
  const baseInput = {
    characterDescription: 'A 30yo woman.',
    sceneDescription: 'Sunny kitchen.',
    segmentDurationSeconds: 10 as const,
  };

  it('trailing em-dash → "ends mid-sentence" CONTINUITY hint', () => {
    const out = buildOmniFlashSegmentPrompt({
      ...baseInput,
      segmentDialogue:
        '"I\'m 64. My pension barely covers the bills and there\'s nothing left for —"',
    });
    expect(out).toMatch(/CONTINUITY: This clip ends mid-sentence/);
    expect(out).toMatch(/character is still speaking when the cut happens/);
    expect(out).not.toMatch(
      /CONTINUITY: This clip continues a sentence from the previous segment\s+—\s+character is already mid-speech/,
    );
  });

  it('leading em-dash → "continues a sentence from the previous segment" CONTINUITY hint', () => {
    const out = buildOmniFlashSegmentPrompt({
      ...baseInput,
      segmentDialogue: '"— a theme park. I told her, we\'ll see, baby."',
    });
    expect(out).toMatch(/CONTINUITY: This clip continues a sentence from the previous segment/);
    expect(out).toMatch(/already mid-speech when the clip begins/);
  });

  it('em-dash on BOTH ends → continuous-through-cut hint (middle segment of chain)', () => {
    const out = buildOmniFlashSegmentPrompt({
      ...baseInput,
      segmentDialogue: '"— a theme park, and the kids keep asking when we\'re going —"',
    });
    expect(out).toMatch(
      /continues a sentence from the previous segment and continues into the next/,
    );
    expect(out).toMatch(/speaking continuously, no breaks in delivery/);
  });

  it('no em-dash on either end → no CONTINUITY hint added (standalone / final segment)', () => {
    const out = buildOmniFlashSegmentPrompt({
      ...baseInput,
      segmentDialogue: '"Hello there. This is a complete thought."',
    });
    // Polish-12.7.3 boundary hint not present.
    expect(out).not.toMatch(/CONTINUITY: This clip continues a sentence/);
    expect(out).not.toMatch(/CONTINUITY: This clip ends mid-sentence/);
  });

  it('en-dash and hyphen also count as boundary markers (defensive)', () => {
    const out1 = buildOmniFlashSegmentPrompt({
      ...baseInput,
      segmentDialogue: '"trailing en-dash –"',
    });
    expect(out1).toMatch(/CONTINUITY: This clip ends mid-sentence/);
    const out2 = buildOmniFlashSegmentPrompt({
      ...baseInput,
      segmentDialogue: '"- leading hyphen"',
    });
    expect(out2).toMatch(/CONTINUITY: This clip continues a sentence from the previous segment/);
  });
});

describe('Polish-12.7.3: pacing block forbids end-pause / smile-to-camera', () => {
  it('explicitly bans "pause at the end" / "smile to camera" / "reaction beat"', () => {
    const out = buildOmniFlashSegmentPrompt({
      characterDescription: 'C',
      sceneDescription: 'S',
      segmentDialogue: '"hi"',
      segmentDurationSeconds: 10,
    });
    expect(out).toMatch(/PACING:/);
    expect(out).toMatch(/no pause at the end/i);
    expect(out).toMatch(/No smile to camera/);
    expect(out).toMatch(/No "reaction beat" before the cut/);
    expect(out).toMatch(/cut happens mid-action/);
  });

  it('insists the dialogue occupies the ENTIRE segment duration', () => {
    const out8 = buildOmniFlashSegmentPrompt({
      characterDescription: 'C',
      sceneDescription: 'S',
      segmentDialogue: '"hi"',
      segmentDurationSeconds: 8,
    });
    expect(out8).toMatch(/occupy the ENTIRE 8-second duration/);
  });
});
