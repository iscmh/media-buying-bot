/**
 * Polish-28.0.2 Commit 64.2 tripwire: persona shape coercer.
 *
 * Real failure mode this defends against: Polish-28 worker crashed
 * with `TypeError: f.persona.trim is not a function` because the
 * POLISH23_VISION_SYSTEM_PROMPT emits `analysis.persona` as a
 * STRUCTURED OBJECT ({ gender, age_range, ethnicity, look,
 * voice_tone }) — not a string. Commit 64's worker assumed string
 * and called .trim() directly.
 *
 * flattenPersonaForClonePrompt accepts either shape and returns a
 * usable description string suitable for the Nano Banana Pro
 * character-clone prompt.
 */
import { describe, expect, it } from 'vitest';
import { flattenPersonaForClonePrompt } from '../src/nano-banana-character-clone-prompt';

describe('flattenPersonaForClonePrompt — Polish-23 structured object (the real failure vector)', () => {
  it('renders the operator-reported persona object without crashing', () => {
    const persona = {
      look: 'Older gentleman with silver hair, warm expression, cozy sweater indoor',
      gender: 'male',
      age_range: '60s',
      ethnicity: 'white',
      voice_tone: 'Warm, gentle, sincere',
    };
    const out = flattenPersonaForClonePrompt(persona);
    expect(out).toContain('Age: 60s');
    expect(out).toContain('Gender: male');
    expect(out).toContain('Ethnicity: white');
    expect(out).toContain('Look: Older gentleman with silver hair');
  });

  it('OMITS voice_tone (audio-only signal, irrelevant to visual portrait)', () => {
    const persona = {
      gender: 'female',
      age_range: '30s',
      ethnicity: 'latino',
      look: 'Latina professional in blazer',
      voice_tone: 'Confident and warm',
    };
    const out = flattenPersonaForClonePrompt(persona);
    expect(out).not.toContain('voice_tone');
    expect(out).not.toContain('Voice');
    expect(out).not.toContain('Warm');
  });

  it('handles partial persona (missing optional fields) without inserting empty labels', () => {
    const persona = { gender: 'female', look: 'Woman in a plain t-shirt' };
    const out = flattenPersonaForClonePrompt(persona);
    expect(out).toContain('Gender: female');
    expect(out).toContain('Look: Woman in a plain t-shirt');
    expect(out).not.toContain('Age:');
    expect(out).not.toContain('Ethnicity:');
  });
});

describe('flattenPersonaForClonePrompt — string input (freeform / degraded)', () => {
  it('passes a plain string through trimmed', () => {
    const out = flattenPersonaForClonePrompt('  A quiet middle-aged man in a hoodie  ');
    expect(out).toBe('A quiet middle-aged man in a hoodie');
  });

  it('handles empty string', () => {
    expect(flattenPersonaForClonePrompt('')).toBe('');
    expect(flattenPersonaForClonePrompt('   ')).toBe('');
  });
});

describe('flattenPersonaForClonePrompt — UGC_DECONSTRUCTOR fallback (subject.appearance)', () => {
  it('reads `appearance` field when the caller passes subject-shape', () => {
    const subject = {
      appearance: 'A young man with short brown hair and a black t-shirt',
    };
    const out = flattenPersonaForClonePrompt(subject);
    expect(out).toContain('Look: A young man with short brown hair');
  });
});

describe('flattenPersonaForClonePrompt — hard-fail cases (return empty)', () => {
  it('returns empty string for null', () => {
    expect(flattenPersonaForClonePrompt(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(flattenPersonaForClonePrompt(undefined)).toBe('');
  });

  it('returns empty string for number / boolean (never crashes)', () => {
    expect(flattenPersonaForClonePrompt(42)).toBe('');
    expect(flattenPersonaForClonePrompt(true)).toBe('');
  });

  it('returns empty string for object with no useful fields', () => {
    expect(flattenPersonaForClonePrompt({ foo: 'bar', baz: 42 })).toBe('');
  });

  it('gracefully skips non-string field values on the persona object', () => {
    const persona = { gender: 'male', age_range: null, look: 42, ethnicity: 'white' };
    const out = flattenPersonaForClonePrompt(persona);
    expect(out).toContain('Gender: male');
    expect(out).toContain('Ethnicity: white');
    expect(out).not.toContain('Age:');
    expect(out).not.toContain('Look:');
  });
});
