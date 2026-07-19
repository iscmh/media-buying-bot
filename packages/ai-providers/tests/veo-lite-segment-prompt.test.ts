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

describe('Polish-23 Commit 3.0.27: composeCharacterLockPrefix — structured sheet + first-person anchor + Negative keywords', () => {
  // Prior 3.0.25/3.0.26 pins for "MATCH REFERENCE IMAGE EXACTLY"
  // + 7-REJECT command block are INTENTIONALLY REMOVED here. Google's
  // Veo 3.1 prompting guide states negative prompting should be
  // "declarative, not instructive — the model responds poorly to
  // commands like 'don't' or 'no'." The command-form REJECT block
  // was net-negative. Replaced by a bare Negative: keyword list.

  it('carries the REFERENCE IMAGE literal caption line', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain('REFERENCE IMAGE:');
    expect(prefix).toMatch(/depicts a 68-year-old American female named Linda/);
    expect(prefix).toContain('suburban grandmother');
  });

  it('carries the structured CHARACTER SHEET with fixed field labels', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain('CHARACTER SHEET (identical across all 8 clips):');
    expect(prefix).toContain('NAME: Linda');
    expect(prefix).toContain('GENDER: female');
    expect(prefix).toContain('AGE: 68');
    expect(prefix).toContain('ETHNICITY: American');
    expect(prefix).toContain('DEMOGRAPHIC: suburban grandmother');
    expect(prefix).toContain('FACE:');
    expect(prefix).toContain('BODY:');
    expect(prefix).toContain('HAIR:');
    expect(prefix).toContain('SKIN:');
    expect(prefix).toContain('WARDROBE:');
    expect(prefix).toContain('SETTING:');
    expect(prefix).toContain('LIGHTING:');
    expect(prefix).toContain('CAMERA:');
  });

  it('carries the first-person IDENTITY ANCHOR line', () => {
    // Polish-23 Commit 3.0.27: kept tight per Google's Veo 3.1
    // guide "weights first ~150 words heaviest" — wardrobe + setting
    // details already appear in the CHARACTER SHEET's WARDROBE: /
    // SETTING: fields above. The IDENTITY ANCHOR is just the
    // first-person same-person reinforcement.
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toMatch(
      /IDENTITY ANCHOR: I am Linda, the SAME PERSON shown in the reference image/,
    );
  });

  it('carries the bare Negative keyword list (NO command-form REJECT lines)', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain('Negative:');
    expect(prefix).toContain('different person');
    expect(prefix).toContain('weight change');
    expect(prefix).toContain('wardrobe change');
    expect(prefix).toContain('lighting change');
    expect(prefix).toContain('plastic skin');
    // Anti-AI-artifact guards absorbed into the Negative list (used
    // to live on a separate "ABSOLUTELY NO …" line in Commit 2).
    expect(prefix).toContain('phones in frame');
    expect(prefix).toContain('watermark');
    expect(prefix).toContain('on-screen text');
    // Command-form REJECTs must NOT appear (violates Google's
    // Veo 3.1 declarative-not-instructive rule).
    expect(prefix).not.toContain('REJECT any change in');
    expect(prefix).not.toContain('MATCH REFERENCE IMAGE EXACTLY');
  });

  it('prefix character count is bounded: > 800 (structured sheet is substantive) AND < 2500 (attention headroom)', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix.length).toBeGreaterThan(800);
    expect(prefix.length).toBeLessThan(2500);
  });

  it('male character variant emits structured sheet with GENDER: male + first-person "I am <name>"', () => {
    const male: CharacterLock = { ...LINDA, gender: 'male', name: 'David', age: 62 };
    const prefix = composeCharacterLockPrefix(male);
    expect(prefix).toContain('GENDER: male');
    expect(prefix).toContain('NAME: David');
    expect(prefix).toContain('AGE: 62');
    expect(prefix).toMatch(/IDENTITY ANCHOR: I am David/);
    expect(prefix).toMatch(/He is speaking directly to the camera/);
  });
});

describe('Polish-23 Commit 3.0.27: composeReferenceImageCaption — literal 1-sentence caption', () => {
  it('names age + nationality + gender + demographic_role + wardrobe + setting', async () => {
    const { composeReferenceImageCaption } = await import('../src/veo-lite-segment-prompt');
    const caption = composeReferenceImageCaption(LINDA);
    expect(caption).toMatch(/^The reference image \(shown in imageUrls\) depicts a /);
    expect(caption).toMatch(/68-year-old American female named Linda/);
    expect(caption).toContain('suburban grandmother');
  });
  it('caption length stays short (1-2 sentences, < 400 chars) so Veo weights it early', async () => {
    const { composeReferenceImageCaption } = await import('../src/veo-lite-segment-prompt');
    const caption = composeReferenceImageCaption(LINDA);
    expect(caption.length).toBeLessThan(400);
  });
});

describe('Polish-23 Commit 3.0.27: POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS + seed range constants', () => {
  it('exports the exact seed range documented by kie.ai (10000-99999)', async () => {
    const { POLISH23_VEO_SEED_MIN, POLISH23_VEO_SEED_MAX } =
      await import('../src/veo-lite-segment-prompt');
    expect(POLISH23_VEO_SEED_MIN).toBe(10000);
    expect(POLISH23_VEO_SEED_MAX).toBe(99999);
  });
  it('Negative keyword list is a bare comma-separated string (NO imperative verbs)', async () => {
    const { POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS } =
      await import('../src/veo-lite-segment-prompt');
    // Must contain the character-consistency keywords.
    expect(POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS).toContain('different person');
    expect(POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS).toContain('weight change');
    expect(POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS).toContain('setting change');
    // Must contain the anti-AI-artifact keywords (absorbed from
    // the old "ABSOLUTELY NO …" tail).
    expect(POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS).toContain('phones in frame');
    expect(POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS).toContain('watermark');
    // Must NOT contain command-form verbs (Google's declarative rule).
    expect(POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS).not.toMatch(/\b(don't|do not|REJECT|NEVER)\b/);
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

  it('threads the structured-sheet bullets (face_shape / eye_color / body / hair / skin)', () => {
    // Polish-23 Commit 3.0.27: Google's Veo 3.1 guide recommends
    // text + image conditioning fuse against ONE reference — so
    // the per-clip Veo prompt keeps a summary bullet set, and the
    // fine-grained face bullets (eye_asymmetry / nose / mouth /
    // jaw) are provided by the Higgsfield Soul reference image
    // itself (via imageUrls[]) rather than duplicated in text.
    // Duplicating everything blows past the 150-word attention
    // sweet spot and dilutes the character-lock signal.
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain(LINDA.face_shape_bullet);
    expect(prefix).toContain(LINDA.eye_color_and_age_detail);
    expect(prefix).toContain(LINDA.body_invariant_bullet);
    expect(prefix).toContain(LINDA.hair_bullet);
    expect(prefix).toContain(LINDA.skin_age_appropriate_detail);
  });

  it('carries wardrobe + setting invariants (Commit 3.0.27: as structured-sheet WARDROBE: / SETTING: fields, not "WARDROBE INVARIANT" label)', () => {
    const prefix = composeCharacterLockPrefix(LINDA);
    expect(prefix).toContain(LINDA.clothing_bullet);
    expect(prefix).toContain(LINDA.setting_paragraph);
    expect(prefix).toMatch(/^WARDROBE: /m);
    expect(prefix).toMatch(/^SETTING: /m);
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

  it('anti-AI directive absorbed into the Negative: keyword list (Commit 3.0.27 — replaces "ABSOLUTELY NO …" tail)', () => {
    // Polish-23 Commit 3.0.27: Google's Veo 3.1 prompting guide
    // recommends bare keyword lists over command-form directives.
    // The Commit 2 "ABSOLUTELY NO on-screen text …" tail is now
    // folded into the Negative: keyword list inside the prefix.
    const out = composeVeoLiteSegmentPrompt(LINDA, baseSpec);
    expect(out.prompt).toContain('Negative:');
    expect(out.prompt).toContain('on-screen text');
    expect(out.prompt).toContain('phones in frame');
    expect(out.prompt).toContain('watermark');
    expect(out.prompt).not.toContain('ABSOLUTELY NO');
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
