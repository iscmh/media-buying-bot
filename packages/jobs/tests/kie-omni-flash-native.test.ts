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
  decideOmniAttemptOutcome,
  estimateDialogueSeconds,
  isRetryableOmniFailure,
  RETRYABLE_OMNI_FAIL_CODES,
  runOmniSegment,
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
    expect(RETRYABLE_OMNI_FAIL_CODES.size).toBe(3);
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
