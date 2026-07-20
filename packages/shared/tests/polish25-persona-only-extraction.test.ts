/**
 * Polish-25 Commit 3 regression pins.
 *
 * Root cause of the Commit-2 failure on job 481a7659:
 *   The Polish-25 worker was calling `parsePolish23VisionAdditions`,
 *   which returns null if ANY sibling of `persona`
 *   (setting_details / emotional_arc / hook_structure / niche_category)
 *   is missing or malformed. Persona was populated correctly, but the
 *   strict parser threw the whole bundle away — worker then reported
 *   "run analyze-concept first" even though it already had.
 *
 * Fix: Polish-25 worker now calls `Polish23PersonaSchema.safeParse`
 * on JUST the persona sub-field. This test pins that behavior at the
 * schema level so any future tightening of `Polish23PersonaSchema`
 * catches Polish-25's regression here (rather than at runtime on a
 * real MakeUGC job).
 *
 * Polish-23 worker keeps calling `parsePolish23VisionAdditions` (needs
 * setting_details for Higgsfield Soul prompt construction); the strict
 * parser's behavior is unchanged and re-pinned below to prevent
 * accidental relaxation.
 */
import { describe, expect, it } from 'vitest';
import {
  Polish23PersonaSchema,
  parsePolish23VisionAdditions,
} from '../src/polish23-vision-analysis';

const validPersona = {
  gender: 'male',
  age_range: '60s',
  ethnicity: 'white',
  look: 'casual, clean-shaven, medium build, short gray hair',
  voice_tone: 'warm, conversational, measured pacing',
};

describe('Polish-25 Commit 3: persona-only extraction succeeds with partial hydration', () => {
  it('parses persona when persona is valid + ALL siblings missing', () => {
    const analysis = { persona: validPersona };
    const result = Polish23PersonaSchema.safeParse(analysis.persona);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gender).toBe('male');
      expect(result.data.age_range).toBe('60s');
      expect(result.data.ethnicity).toBe('white');
    }
  });

  it('parses persona when siblings are present but malformed (each in turn)', () => {
    const cases = [
      { setting_details: 'not-an-object' },
      { emotional_arc: { starting_emotion: 'x' } }, // missing key_beats
      { hook_structure: 'not-a-valid-enum' },
      { niche_category: '' }, // empty string violates min(1)
      { setting_details: null, emotional_arc: null, hook_structure: null, niche_category: null },
    ];
    for (const siblings of cases) {
      const analysis = { persona: validPersona, ...siblings };
      const result = Polish23PersonaSchema.safeParse(analysis.persona);
      expect(result.success).toBe(true);
    }
  });

  it('parses persona when analyze-concept emitted ONLY persona (real-world Gemini partial)', () => {
    const analysis = { persona: validPersona };
    const result = Polish23PersonaSchema.safeParse(analysis.persona);
    expect(result.success).toBe(true);
  });
});

describe('Polish-25 Commit 3: persona-only extraction still rejects broken persona', () => {
  it('rejects when persona is missing entirely', () => {
    const result = Polish23PersonaSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });

  it('rejects when persona is not an object', () => {
    expect(Polish23PersonaSchema.safeParse('a string').success).toBe(false);
    expect(Polish23PersonaSchema.safeParse(42).success).toBe(false);
    expect(Polish23PersonaSchema.safeParse(null).success).toBe(false);
  });

  it('rejects when persona.gender is out of enum', () => {
    const result = Polish23PersonaSchema.safeParse({ ...validPersona, gender: 'nonbinary' });
    expect(result.success).toBe(false);
  });

  it('rejects when persona.ethnicity is out of enum', () => {
    const result = Polish23PersonaSchema.safeParse({ ...validPersona, ethnicity: 'other-thing' });
    expect(result.success).toBe(false);
  });

  it('rejects when persona.age_range / look / voice_tone are empty strings', () => {
    expect(Polish23PersonaSchema.safeParse({ ...validPersona, age_range: '' }).success).toBe(false);
    expect(Polish23PersonaSchema.safeParse({ ...validPersona, look: '' }).success).toBe(false);
    expect(Polish23PersonaSchema.safeParse({ ...validPersona, voice_tone: '' }).success).toBe(
      false,
    );
  });
});

describe('Polish-23 strict parser unchanged (Polish-25 Commit 3 keeps Polish-23 behavior intact)', () => {
  const validSettingDetails = {
    interior_or_exterior: 'interior',
    room_or_place: 'kitchen',
    lighting: 'warm morning light',
    key_props: ['coffee mug', 'phone'],
  };
  const validEmotionalArc = {
    starting_emotion: 'skeptical',
    ending_emotion: 'delighted',
    key_beats: ['skeptical', 'curious', 'convinced', 'delighted'],
  };
  const validAdditions = {
    persona: validPersona,
    setting_details: validSettingDetails,
    emotional_arc: validEmotionalArc,
    hook_structure: 'story',
    niche_category: 'personal_finance',
  };

  it('parsePolish23VisionAdditions still requires the full bundle', () => {
    // Full bundle → parses.
    expect(parsePolish23VisionAdditions(validAdditions)).not.toBeNull();

    // Any missing sibling → returns null (Polish-23 behavior preserved).
    const stripped: Array<keyof typeof validAdditions> = [
      'setting_details',
      'emotional_arc',
      'hook_structure',
      'niche_category',
    ];
    for (const key of stripped) {
      const partial = { ...validAdditions };
      delete (partial as Record<string, unknown>)[key];
      expect(parsePolish23VisionAdditions(partial)).toBeNull();
    }
  });

  it('parsePolish23VisionAdditions returns null on the exact Polish-25 partial that motivated Commit 3', () => {
    // Job 481a7659 shape: persona populated, siblings absent.
    const polish25PartialShape = { persona: validPersona };
    // Polish-23 parser rejects (this is the bug Polish-25 Commit 3 works around).
    expect(parsePolish23VisionAdditions(polish25PartialShape)).toBeNull();
    // But persona-only extraction accepts it (the fix).
    expect(Polish23PersonaSchema.safeParse(polish25PartialShape.persona).success).toBe(true);
  });
});
