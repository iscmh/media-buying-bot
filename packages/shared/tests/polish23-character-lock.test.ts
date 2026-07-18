import { describe, expect, it } from 'vitest';
import {
  CharacterLockSchema,
  CHARACTER_GENDER_VALUES,
  FALLBACK_CHARACTER_LOCK,
  SKIN_COLOR_FOR_STUBBLE_VALUES,
  parseCharacterLock,
  type CharacterLock,
} from '../src/polish23-character-lock';

const VALID: CharacterLock = {
  name: 'Marcus',
  age: 42,
  nationality: 'Filipino',
  gender: 'male',
  demographic_role: 'middle-aged office worker',
  hair_bullet: 'Short jet-black hair, slightly messy, NOT styled, NOT symmetrical',
  eye_asymmetry_bullet:
    'Slightly uneven eye line — left eyelid heavier than right (natural asymmetry)',
  nose_bullet: 'Ordinary nose — small bump at the bridge and slightly wide nostrils',
  mouth_bullet: 'Medium lips, slightly asymmetric mouth, natural slight downturn on the right side',
  eye_color_and_age_detail:
    "Dark warm brown eyes with faint crow's feet and mild under-eye shadows",
  jaw_bullet: 'Soft jawline with mild jowl weight (age-appropriate)',
  face_shape_bullet: 'Broad oval face, NOT chiseled, NOT model-shaped',
  clothing_bullet: 'Faded charcoal cotton polo with honest wear at the collar',
  setting_paragraph:
    'Home office corner, cool morning light from a north-facing window off-camera. Cluttered lived-in feel.',
  skin_age_appropriate_detail:
    'faint sun-spot pigmentation on cheekbones, natural pore texture on nose',
  skin_color_for_stubble: 'black',
  anti_celeb_actress_examples: ['Meryl Streep', 'Helen Mirren', 'Jane Fonda', 'Diane Keaton'],
  anti_celeb_news_examples: ['Barbara Walters', 'Diane Sawyer'],
  anti_celeb_politician_examples: ['Nancy Pelosi', 'Hillary Clinton'],
  body_invariant_bullet:
    'Medium build, average weight for a 42-year-old man, moderate shoulder width — SAME weight, SAME body proportions, SAME shoulder width across every clip.',
  setting_invariant_bullet:
    'Seated at a home-office desk with a black ceramic coffee mug in front of him, cool morning window light from off-camera left — SAME chair, SAME desk position, SAME mug placement across every clip.',
};

describe('Polish-23 Commit 1: CharacterLock type + schema shape', () => {
  it('every field in the shipping Polish-21.0.7 Linda pattern survives the schema round-trip', () => {
    // Regression pin against silent field drift: if a future edit
    // renames `hair_bullet` → `hair_description`, the schema
    // validation catches it before per-clip Veo prompts start
    // interpolating undefined.
    const parsed = CharacterLockSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // All 21 fields present (Polish-23 Commit 3.0.17: added
    // body_invariant_bullet + setting_invariant_bullet to prevent
    // cross-clip drift observed in first real end-to-end run).
    expect(Object.keys(parsed.data).sort()).toEqual(
      [
        'name',
        'age',
        'nationality',
        'gender',
        'demographic_role',
        'hair_bullet',
        'eye_asymmetry_bullet',
        'nose_bullet',
        'mouth_bullet',
        'eye_color_and_age_detail',
        'jaw_bullet',
        'face_shape_bullet',
        'clothing_bullet',
        'setting_paragraph',
        'skin_age_appropriate_detail',
        'skin_color_for_stubble',
        'anti_celeb_actress_examples',
        'anti_celeb_news_examples',
        'anti_celeb_politician_examples',
        'body_invariant_bullet',
        'setting_invariant_bullet',
      ].sort(),
    );
  });

  it('gender union is exactly {male, female} — no neutral/nonbinary (Nano Banana needs a definite gender)', () => {
    expect(CHARACTER_GENDER_VALUES).toEqual(['male', 'female']);
  });

  it('skin_color_for_stubble is the exact Polish-21.0.7 enum (5 colors + none)', () => {
    expect(SKIN_COLOR_FOR_STUBBLE_VALUES).toEqual([
      'grey',
      'brown',
      'black',
      'blonde',
      'red',
      'none',
    ]);
  });

  it('rejects gender values that are not male/female (silent widening guard)', () => {
    const r = CharacterLockSchema.safeParse({ ...VALID, gender: 'nonbinary' });
    expect(r.success).toBe(false);
  });

  it('rejects fewer than 4 actresses (anti-celeb block would ship anemic)', () => {
    const r = CharacterLockSchema.safeParse({
      ...VALID,
      anti_celeb_actress_examples: ['A', 'B', 'C'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects fewer than 2 news anchors / politicians', () => {
    const r1 = CharacterLockSchema.safeParse({
      ...VALID,
      anti_celeb_news_examples: ['Barbara Walters'],
    });
    expect(r1.success).toBe(false);
    const r2 = CharacterLockSchema.safeParse({
      ...VALID,
      anti_celeb_politician_examples: ['Nancy Pelosi'],
    });
    expect(r2.success).toBe(false);
  });

  it('rejects non-positive age (0, -5, non-integer)', () => {
    expect(CharacterLockSchema.safeParse({ ...VALID, age: 0 }).success).toBe(false);
    expect(CharacterLockSchema.safeParse({ ...VALID, age: -5 }).success).toBe(false);
    expect(CharacterLockSchema.safeParse({ ...VALID, age: 42.5 }).success).toBe(false);
  });
});

describe('Polish-23 Commit 1: parseCharacterLock + FALLBACK_CHARACTER_LOCK', () => {
  it('parses a well-formed record', () => {
    expect(parseCharacterLock(VALID)).toEqual(VALID);
  });

  it('falls back to FALLBACK_CHARACTER_LOCK on null / undefined / array / string / missing fields', () => {
    expect(parseCharacterLock(null)).toEqual(FALLBACK_CHARACTER_LOCK);
    expect(parseCharacterLock(undefined)).toEqual(FALLBACK_CHARACTER_LOCK);
    expect(parseCharacterLock('string')).toEqual(FALLBACK_CHARACTER_LOCK);
    expect(parseCharacterLock([])).toEqual(FALLBACK_CHARACTER_LOCK);
    // Partial (missing hair_bullet) → whole-record fallback.
    const partial = { ...VALID } as Record<string, unknown>;
    delete partial['hair_bullet'];
    expect(parseCharacterLock(partial)).toEqual(FALLBACK_CHARACTER_LOCK);
  });

  it('FALLBACK is Linda — Polish-21.0.7 verified anchor (regression pin)', () => {
    // Polish-21 and Polish-23 must share the same visual reference
    // when they fall back to the safe shape. Any silent edit to the
    // fallback bullets ripples through both pipelines.
    expect(FALLBACK_CHARACTER_LOCK.name).toBe('Linda');
    expect(FALLBACK_CHARACTER_LOCK.age).toBe(68);
    expect(FALLBACK_CHARACTER_LOCK.gender).toBe('female');
    expect(FALLBACK_CHARACTER_LOCK.demographic_role).toBe('suburban grandmother');
    expect(FALLBACK_CHARACTER_LOCK.anti_celeb_actress_examples).toContain('Meryl Streep');
  });
});
