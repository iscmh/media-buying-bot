import { describe, expect, it } from 'vitest';
import { synthesizePersonaFromSubject } from '../src/persona-synthesizer';

/**
 * Polish-26.0.6 Commit 61.6 tripwire: the persona synthesizer that
 * lets polish26_heygen work on concepts analyzed under the
 * subject-only UGC_DECONSTRUCTOR shape (missing structured
 * persona field).
 *
 * The two invariants that MUST hold:
 *   1. Gender extraction must be right — it's a HARD FILTER in the
 *      HeyGen avatar matcher (never cross-gender-bind an avatar).
 *      A wrong gender here means every generation picks a wrong-
 *      sex actor.
 *   2. Missing signal → null (worker fails loud with an actionable
 *      "run analyze-concept" message) rather than routing to a
 *      random avatar with a fabricated persona.
 */

describe('synthesizePersonaFromSubject', () => {
  it("returns null on empty / missing input (worker's fail-loud path)", () => {
    expect(synthesizePersonaFromSubject(null)).toBeNull();
    expect(synthesizePersonaFromSubject(undefined)).toBeNull();
    expect(synthesizePersonaFromSubject({})).toBeNull();
    expect(synthesizePersonaFromSubject({ subject: {} })).toBeNull();
    expect(synthesizePersonaFromSubject('not an object')).toBeNull();
  });

  it('returns null when nothing carries a gender signal (defensive default)', () => {
    // subject.appearance describes a product, not a person. Refuse
    // to guess — no gender ⇒ null.
    const analysis = {
      subject: { appearance: 'a bottle of energy drink on a wooden table' },
      audio_cues: { dialogue_quality: 'crisp studio recording' },
    };
    expect(synthesizePersonaFromSubject(analysis)).toBeNull();
  });

  it("routes a young-woman appearance to female + 20s (operator's ddca175b shape)", () => {
    // Real-world shape reported by the operator on concept ddca175b.
    const analysis = {
      subject: {
        appearance: '25-year-old white woman with short brown hair, standing in kitchen',
        performance: 'she speaks directly to camera in an energetic tone',
      },
      audio_cues: {
        background_sound: 'kitchen hum',
        dialogue_quality: 'energetic, high-pitched female voice with slight regional accent',
      },
      social_context: 'first-person POV, phone-held selfie framing',
    };
    const r = synthesizePersonaFromSubject(analysis);
    expect(r).not.toBeNull();
    expect(r!.persona.gender).toBe('female');
    expect(r!.persona.age_range).toBe('20s');
    expect(r!.persona.ethnicity).toBe('white');
    expect(r!.persona.voice_tone).toBe('energetic');
    // Look must be non-empty (soft-score fuel for the matcher).
    expect(r!.persona.look.length).toBeGreaterThan(5);
    // sources record must include what we actually read.
    expect(r!.sources).toContain('subject.appearance');
    expect(r!.sources).toContain('audio_cues.dialogue_quality');
  });

  it('recognizes middle-aged male + numeric age → 40s', () => {
    const analysis = {
      subject: { appearance: '45-year-old man with dark beard, business casual' },
    };
    const r = synthesizePersonaFromSubject(analysis);
    expect(r!.persona.gender).toBe('male');
    expect(r!.persona.age_range).toBe('40s');
  });

  it('maps latino/latina/mexican keywords to hispanic (Polish-23 enum has no latino slot)', () => {
    const analysis = {
      subject: { appearance: 'young latina woman with long dark hair' },
    };
    const r = synthesizePersonaFromSubject(analysis);
    expect(r!.persona.gender).toBe('female');
    expect(r!.persona.ethnicity).toBe('hispanic');
  });

  it('recognizes senior male + "elderly" → 70s', () => {
    const analysis = {
      subject: { appearance: 'elderly gentleman, gray hair, kind expression' },
      audio_cues: { dialogue_quality: 'calm, warm delivery' },
    };
    const r = synthesizePersonaFromSubject(analysis);
    expect(r!.persona.gender).toBe('male');
    expect(r!.persona.age_range).toBe('70s');
    // Voice tone matcher hits "calm" first.
    expect(r!.persona.voice_tone).toBe('calm');
  });

  it('picks the more prominent gender on mixed hits (tie → female)', () => {
    // Ambiguous string mentions both. Not the common case but pin
    // the tiebreak so a future refactor doesn't silently flip it.
    const analysis = {
      subject: { appearance: 'a man and a woman speaking, though she speaks first' },
    };
    const r = synthesizePersonaFromSubject(analysis);
    expect(r!.persona.gender).toBe('female'); // more female-signal words in the string
  });

  it("defaults age_range to 30s + ethnicity to 'other' when the strings don't specify", () => {
    const analysis = {
      subject: { appearance: 'woman with sunglasses' },
    };
    const r = synthesizePersonaFromSubject(analysis);
    expect(r!.persona.gender).toBe('female');
    expect(r!.persona.age_range).toBe('30s'); // documented default
    expect(r!.persona.ethnicity).toBe('other'); // documented default
  });
});
