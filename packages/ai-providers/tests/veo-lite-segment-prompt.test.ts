/**
 * Polish-23 Commit 2: per-clip Veo Lite prompt composer tests.
 * Pins:
 *   - CHARACTER LOCK prefix is threaded into every clip
 *   - 20-24 word dialogue window (Polish-19.4.2 calibration retuned for 8s @ 170wpm)
 *   - segment header names position (SEGMENT N/M) so callers can grep logs
 *   - pronouns match character gender
 *   - anti-AI + anti-on-screen-text directive tail present
 *   - checkDialogueWordCount surfaces both under-fill and over-fill
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK_CHARACTER_LOCK, type CharacterLock } from '@mbb/shared';
import {
  checkDialogueWordCount,
  composeCharacterLockPrefix,
  composeVeoLiteSegmentPrompt,
  countDialogueWords,
  VEO_LITE_CLIP_SECONDS,
  VEO_LITE_MAX_DIALOGUE_WORDS,
  VEO_LITE_MIN_DIALOGUE_WORDS,
  VEO_LITE_WPM,
} from '../src/veo-lite-segment-prompt';

const LINDA: CharacterLock = FALLBACK_CHARACTER_LOCK;

// Exact-length dialogue helpers so the tests don't depend on Linda's
// specific ad script.
const D22 =
  'I tried this app for two whole weeks and honestly the most surprising part was how much I saved on gas alone.'; // 22 words
const D18 = 'I tried this app for two weeks and honestly the surprising part was how much I saved.'; // 18 (under)
const D28 =
  'I tried this brand new grocery savings app for two whole weeks and honestly the surprising part was how much I saved on gas alone every single day.'; // 28 (over)

describe('Polish-23 Commit 2: countDialogueWords + checkDialogueWordCount (170wpm × 8s = 20–24)', () => {
  it('constants are the operator-spec anchors', () => {
    expect(VEO_LITE_WPM).toBe(170);
    expect(VEO_LITE_CLIP_SECONDS).toBe(8);
    expect(VEO_LITE_MIN_DIALOGUE_WORDS).toBe(20);
    expect(VEO_LITE_MAX_DIALOGUE_WORDS).toBe(24);
  });

  it('counts whitespace-split tokens (contractions stay one word)', () => {
    // "I don't know but I'd try it." → I(1) don't(2) know(3) but(4) I'd(5) try(6) it.(7) = 7 words
    expect(countDialogueWords("I don't know but I'd try it.")).toBe(7);
    expect(countDialogueWords('   spaces   collapse   ')).toBe(2);
    expect(countDialogueWords('')).toBe(0);
  });

  it('22 words → ok; 18 → under-fill error; 28 → over-fill error', () => {
    expect(checkDialogueWordCount(D22).ok).toBe(true);
    expect(checkDialogueWordCount(D18).ok).toBe(false);
    expect(checkDialogueWordCount(D18).message).toMatch(/under-fill|dead air/i);
    expect(checkDialogueWordCount(D28).ok).toBe(false);
    expect(checkDialogueWordCount(D28).message).toMatch(/over-fill|rushes|clips/i);
  });

  it('boundary anchors: 20 words = ok, 24 words = ok', () => {
    const w20 = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const w24 = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');
    expect(checkDialogueWordCount(w20).ok).toBe(true);
    expect(checkDialogueWordCount(w24).ok).toBe(true);
  });
});

describe('Polish-23 Commit 3.0.26: composeCharacterLockPrefix — aggressive MATCH-REFERENCE rewrite pins', () => {
  it('leads with "MATCH REFERENCE IMAGE EXACTLY" imperative', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain('CHARACTER LOCK — MATCH REFERENCE IMAGE EXACTLY.');
    expect(prefix).toContain('Any deviation from the reference image is a FAILURE.');
  });

  it('emits all 7 negative constraints on their own lines', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    // Order matters ONLY for reader scanning; independent lines
    // mean Veo weights each REJECT separately.
    expect(prefix).toContain('REJECT any change in body type.');
    expect(prefix).toContain('REJECT any change in weight.');
    expect(prefix).toContain('REJECT any change in age.');
    expect(prefix).toContain('REJECT any change in facial features.');
    expect(prefix).toContain('REJECT any change in wardrobe.');
    expect(prefix).toContain('REJECT any change in setting.');
    expect(prefix).toContain('REJECT any change in lighting.');
  });

  it('WARDROBE LOCK carries the clothing_bullet AND a "Reference:" excerpt', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain(`WARDROBE INVARIANT (LOCK): ${LINDA.clothing_bullet}`);
    expect(prefix).toContain('SAME clothing as reference image. NEVER change wardrobe.');
    expect(prefix).toContain(`Reference: ${LINDA.clothing_bullet}`);
  });

  it('SETTING LOCK carries the setting_paragraph AND a "Reference:" excerpt', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain(
      'SETTING LOCK: SAME setting / room / background as reference image. NEVER change environment.',
    );
    expect(prefix).toContain(`Reference: ${LINDA.setting_paragraph}`);
  });

  it('prefix character count is > 800 (was ~400 in Polish-23 Commit 2 baseline)', () => {
    // Regression pin: any silent softening of the aggressive
    // rewrite that trims REJECT lines / Reference: excerpts /
    // physical-invariant bullets would push the total below the
    // 800-char floor. Fail loud if that happens.
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix.length).toBeGreaterThan(800);
  });

  it('male character variant still emits all 7 REJECTs + "He is speaking directly to the camera"', () => {
    const male: CharacterLock = { ...LINDA, gender: 'male', name: 'David', age: 62 };
    const prefix = composeCharacterLockPrefix(male);
    expect(prefix).toContain('REJECT any change in body type.');
    expect(prefix).toContain('REJECT any change in wardrobe.');
    expect(prefix).toContain('REJECT any change in lighting.');
    expect(prefix).toMatch(/He is speaking directly to the camera/);
    expect(prefix).toMatch(/62-year-old American male named David/);
  });
});

describe('Polish-23 Commit 2: composeCharacterLockPrefix — invariants', () => {
  it("names age + nationality + gender + role + Linda's name", () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toMatch(/CHARACTER LOCK/);
    expect(prefix).toMatch(/68-year-old American female named Linda/);
    expect(prefix).toMatch(/suburban grandmother/);
    expect(prefix).toMatch(/SAME PERSON across every clip/);
  });

  it('threads all 8 physical-invariant bullets (hair / eye asymmetry / nose / mouth / eye color / jaw / face / skin age)', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain(LINDA.hair_bullet);
    expect(prefix).toContain(LINDA.eye_asymmetry_bullet);
    expect(prefix).toContain(LINDA.nose_bullet);
    expect(prefix).toContain(LINDA.mouth_bullet);
    expect(prefix).toContain(LINDA.eye_color_and_age_detail);
    expect(prefix).toContain(LINDA.jaw_bullet);
    expect(prefix).toContain(LINDA.face_shape_bullet);
    expect(prefix).toContain(LINDA.skin_age_appropriate_detail);
  });

  it('carries wardrobe + setting invariants', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain(LINDA.clothing_bullet);
    expect(prefix).toContain(LINDA.setting_paragraph);
    expect(prefix).toMatch(/WARDROBE INVARIANT/);
  });

  it('pronoun: female → She', () => {
    expect(composeCharacterLockPrefix(LINDA)).toMatch(/She is speaking directly to the camera/);
  });

  it('pronoun: male → He', () => {
    const male: CharacterLock = { ...LINDA, gender: 'male', name: 'Marcus' };
    expect(composeCharacterLockPrefix(male)).toMatch(/He is speaking directly to the camera/);
  });
});

describe('Polish-23 Commit 2: composeVeoLiteSegmentPrompt — full clip prompt', () => {
  const baseSpec = {
    segmentIndex: 0,
    totalSegments: 8,
    dialogue: D22,
    sceneDirection: 'Linda leans in toward the phone camera, gesturing with her free hand.',
  };

  it('CHARACTER LOCK PREFIX is threaded verbatim into every clip', () => {
    const out = composeVeoLiteSegmentPrompt(LINDA, baseSpec);
    expect(out.prompt).toContain(composeCharacterLockPrefix(LINDA));
  });

  it('segment header names position (SEGMENT N/M — 8s) so log grep works', () => {
    const out = composeVeoLiteSegmentPrompt(LINDA, {
      ...baseSpec,
      segmentIndex: 2,
      totalSegments: 8,
    });
    expect(out.prompt).toMatch(/SEGMENT 3\/8 — 8s/);
    expect(out.prompt).toMatch(/target 20-24 spoken words/);
  });

  it('quotes the dialogue exactly (Veo attention picks up the string)', () => {
    const out = composeVeoLiteSegmentPrompt(LINDA, baseSpec);
    expect(out.prompt).toContain(`DIALOGUE: "${D22}"`);
  });

  it('scene direction lands on the SCENE: line', () => {
    const out = composeVeoLiteSegmentPrompt(LINDA, baseSpec);
    expect(out.prompt).toContain('SCENE: ' + baseSpec.sceneDirection);
  });

  it('emotional beat threaded when provided; omitted otherwise', () => {
    const withBeat = composeVeoLiteSegmentPrompt(LINDA, {
      ...baseSpec,
      emotionalBeat: 'reassured',
    });
    expect(withBeat.prompt).toMatch(/Emotional beat: reassured\./);
    const withoutBeat = composeVeoLiteSegmentPrompt(LINDA, baseSpec);
    expect(withoutBeat.prompt).not.toMatch(/Emotional beat:/);
  });

  it('camera anchor: iPhone front camera + 9:16 vertical + handheld feel', () => {
    const out = composeVeoLiteSegmentPrompt(LINDA, baseSpec);
    expect(out.prompt).toMatch(/iPhone front camera, 9:16 vertical/);
    expect(out.prompt).toMatch(/slightly shaky handheld feel/);
  });

  it('anti-AI directive tail: NO on-screen text + NO phones-in-frame (Polish-21.0.7 anchor)', () => {
    const out = composeVeoLiteSegmentPrompt(LINDA, baseSpec);
    expect(out.prompt).toMatch(/ABSOLUTELY NO on-screen text/);
    expect(out.prompt).toMatch(/ABSOLUTELY NO phones, cameras, screens/);
  });

  it('wordCountCheck surfaces on the composed result (worker decides to run or reject)', () => {
    const okOut = composeVeoLiteSegmentPrompt(LINDA, baseSpec);
    expect(okOut.wordCountCheck.ok).toBe(true);
    expect(okOut.wordCountCheck.wordCount).toBe(22);

    const underOut = composeVeoLiteSegmentPrompt(LINDA, { ...baseSpec, dialogue: D18 });
    expect(underOut.wordCountCheck.ok).toBe(false);
    expect(underOut.wordCountCheck.wordCount).toBe(17);
  });

  it('composer does NOT throw on out-of-range dialogue (worker owns the decision)', () => {
    expect(() => composeVeoLiteSegmentPrompt(LINDA, { ...baseSpec, dialogue: D28 })).not.toThrow();
  });
});

describe('Polish-23 Commit 3.0.3: composer never emits an empty prompt (Step-C empty-prompt regression pin)', () => {
  const LINDA_BASE: CharacterLock = FALLBACK_CHARACTER_LOCK;

  it('every position across a full 8-clip batch produces a non-empty prompt >= 500 chars', () => {
    // Anchors the Commit 3.0.3 first-live failure hypothesis:
    // Step C0 reached kie.ai with an empty prompt. For that to be
    // the composer's fault, this test would fail. Instead it pins
    // the composer as blameless — the operator's next debug should
    // look at wire-body shape (see kie-veo.ts Commit 3.0.3 error
    // logs) rather than the composer.
    for (let i = 0; i < 8; i++) {
      const out = composeVeoLiteSegmentPrompt(LINDA_BASE, {
        segmentIndex: i,
        totalSegments: 8,
        dialogue: D22,
        sceneDirection: 'Linda leans in, waves at the camera.',
        emotionalBeat: 'reassured',
      });
      expect(out.prompt.trim().length).toBeGreaterThan(500);
      expect(out.prompt).toContain('CHARACTER LOCK');
      expect(out.prompt).toContain(`SEGMENT ${i + 1}/8`);
      expect(out.prompt).toContain(D22);
    }
  });

  it('male character variant produces a non-empty prompt too (guards against gender-branch drift)', () => {
    const male: CharacterLock = { ...LINDA_BASE, gender: 'male', name: 'Marcus' };
    const out = composeVeoLiteSegmentPrompt(male, {
      segmentIndex: 0,
      totalSegments: 8,
      dialogue: D22,
      sceneDirection: 'Marcus points at the camera, grinning.',
    });
    expect(out.prompt.trim().length).toBeGreaterThan(500);
    expect(out.prompt).toMatch(/He is speaking/);
  });

  it('when scene direction is a single character, prompt is STILL non-empty (composer resilient to short scene)', () => {
    // Fuzz-style pin — a Claude that emitted a minimal but valid
    // sceneDirection still produces a valid prompt because the
    // CHARACTER LOCK prefix + camera anchor + anti-AI tail alone
    // are already ~700+ chars.
    const out = composeVeoLiteSegmentPrompt(LINDA_BASE, {
      segmentIndex: 0,
      totalSegments: 8,
      dialogue: D22,
      sceneDirection: 'x',
    });
    expect(out.prompt.trim().length).toBeGreaterThan(500);
  });
});
