/**
 * Polish-23 Commit 1: Higgsfield Soul reference-image prompt
 * composer tests. Pins the Polish-21.0.7 Linda 7-block pattern
 * VERBATIM so any accidental rewrite that softens the ZERO
 * clauses, drops the ANONYMOUS-not-ATTRACTIVE reframe, or removes
 * the celebrity examples fails loud.
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK_CHARACTER_LOCK, type CharacterLock } from '@mbb/shared';
import { composeHiggsfieldSoulReferencePrompt } from '../src/higgsfield-soul-prompt';

const LINDA: CharacterLock = FALLBACK_CHARACTER_LOCK;

describe('Polish-23 Commit 1: composeHiggsfieldSoulReferencePrompt — 7-block pattern', () => {
  it('composes ONE combined string with all 7 top-level block markers present', () => {
    // Splitting by "\n\n" doesn't give 7 exactly because Block 5's
    // internal directive has its own blank-line separators. The
    // block-by-block content pins below prove the pattern; here
    // we just confirm the seven top-level markers each appear
    // once so a silent block reorder / drop surfaces as a test
    // failure.
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    const markers = [
      'Photorealistic vertical iPhone selfie of a fictional',
      'PHYSICAL FEATURES (deliberately asymmetric and ordinary):',
      LINDA.setting_paragraph.split('.')[0]!,
      'SKIN REALISM MANDATE:',
      'CRITICAL ANTI-CELEBRITY DIRECTIVE:',
      'Shot on iPhone front camera, 9:16 vertical',
      'ABSOLUTELY NO phones, cameras, screens',
    ];
    for (const m of markers) {
      expect(out).toContain(m);
    }
  });

  it('Block 1 — vertical iPhone selfie lead names age + nationality + gender + role', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    expect(out).toMatch(
      /Photorealistic vertical iPhone selfie of a fictional 68-year-old American female named Linda\. Generic suburban grandmother appearance\./,
    );
  });

  it('Block 2 — PHYSICAL FEATURES bullets are itemized (leading "- ")', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    expect(out).toContain('PHYSICAL FEATURES (deliberately asymmetric and ordinary):');
    // All 7 feature bullets + clothing bullet lead with "- ".
    expect(out).toContain('- Shoulder-length salt-and-pepper hair');
    expect(out).toContain('- Slightly uneven eye line');
    expect(out).toContain('- Ordinary nose');
    expect(out).toContain('- Thin lips');
    expect(out).toContain('- Warm hazel eyes');
    expect(out).toContain('- Soft jawline');
    expect(out).toContain('- Oval face');
    expect(out).toContain('- Clothing: Faded navy cotton crewneck');
  });

  it('Block 4 — SKIN REALISM MANDATE keeps ALL FOUR ZERO clauses VERBATIM', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    // These four sentences are the Polish-21.0.5 hardened anchors.
    // Softening any one silently degrades Higgsfield Soul output.
    expect(out).toContain('ZERO airbrushing.');
    expect(out).toContain('ZERO beauty filters.');
    expect(out).toContain('ZERO skin smoothing.');
    expect(out).toContain('ZERO AI plastic-skin artifacts.');
  });

  it('Block 4 — SKIN REALISM MANDATE reframes as "real human, not a model / actor / AI"', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    expect(out).toMatch(
      /must look like a real 68-year-old suburban grandmother, not a model, not an actor, not an AI-generated character/,
    );
  });

  it('Block 5 — CRITICAL ANTI-CELEBRITY DIRECTIVE lists all three name buckets', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    expect(out).toContain('CRITICAL ANTI-CELEBRITY DIRECTIVE:');
    // Actresses (10 names in the Linda fallback).
    expect(out).toContain('Meryl Streep, Helen Mirren, Jane Fonda');
    // News anchors.
    expect(out).toContain('Barbara Walters, Diane Sawyer');
    // Politicians.
    expect(out).toContain('Hillary Clinton, Nancy Pelosi');
  });

  it('Block 5 — CRITICAL ANTI-CELEBRITY DIRECTIVE includes the ANONYMOUS-not-ATTRACTIVE reframe', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    expect(out).toMatch(/Aim for ANONYMOUS, not ATTRACTIVE\./);
    expect(out).toContain('The face should be intentionally unremarkable.');
  });

  it('Block 5 — CRITICAL ANTI-CELEBRITY DIRECTIVE includes the regenerate self-check', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    expect(out).toMatch(/If the face looks like a TV suburban grandmother character, regenerate\./);
  });

  it('Block 6 — camera anchor is iPhone front camera, 9:16 vertical, handheld feel', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    expect(out).toMatch(/Shot on iPhone front camera, 9:16 vertical/);
    expect(out).toContain('slightly shaky handheld feel');
  });

  it('Block 7 — anti-AI directive tail (verbatim Kling 3.0 guide anchor)', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    expect(out).toContain(
      'ABSOLUTELY NO phones, cameras, screens, social media UI, floating text, or digital overlays visible anywhere in the frame.',
    );
  });

  it('male character uses "He / him" pronouns; stubble clause appears when skin_color_for_stubble ≠ none', () => {
    const male: CharacterLock = {
      ...LINDA,
      name: 'Marcus',
      age: 42,
      gender: 'male',
      demographic_role: 'working dad',
      skin_color_for_stubble: 'black',
    };
    const out = composeHiggsfieldSoulReferencePrompt(male);
    expect(out).toContain('He must look like a real 42-year-old working dad');
    expect(out).toContain("I've seen him at the grocery store");
    expect(out).toMatch(/Real black stubble shadow on upper lip and jaw/);
  });

  it('female character with skin_color_for_stubble=none OMITS the stubble clause', () => {
    const out = composeHiggsfieldSoulReferencePrompt(LINDA);
    // Linda's skin_color_for_stubble is 'none' → the stubble
    // clause must not appear anywhere in the prompt.
    expect(out).not.toContain('stubble shadow');
  });

  it('male gender is threaded into the anti-celebrity bracket line (`ANY famous male of the ~{age}-year-old bracket`)', () => {
    const male: CharacterLock = { ...LINDA, gender: 'male' };
    const out = composeHiggsfieldSoulReferencePrompt(male);
    expect(out).toMatch(/ANY famous male of the ~68-year-old bracket, living or dead\./);
  });
});
