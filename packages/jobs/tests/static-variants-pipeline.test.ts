import { describe, expect, it } from 'vitest';
import {
  parseVariantsArray,
  renderNanoBananaPrompt,
  type ClaudeCopyVariant,
} from '../src/functions/generate-static-variants';

describe('renderNanoBananaPrompt — Bug 3: variant copy must reach Gemini', () => {
  const copy: ClaudeCopyVariant = {
    variant_index: 2,
    intensity_level: 'medium',
    rationale: 'fresh hook, same persona',
    headline: 'I tried this for 30 days',
    primary_text: 'Mind blown. Here is what happened.',
    description: 'A skeptic gives it a shot.',
  };

  it('places the variant headline as PRIMARY OVERLAY', () => {
    const prompt = renderNanoBananaPrompt(copy, 2);
    expect(prompt).toMatch(/PRIMARY OVERLAY: "I tried this for 30 days"/);
  });

  it('places the primary_text as SECONDARY OVERLAY', () => {
    const prompt = renderNanoBananaPrompt(copy, 2);
    expect(prompt).toMatch(/SECONDARY OVERLAY: "Mind blown\. Here is what happened\."/);
  });

  it('puts the overlay directive BEFORE the template so Gemini prioritizes it', () => {
    const prompt = renderNanoBananaPrompt(copy, 0);
    const overlayIdx = prompt.indexOf('PRIMARY OVERLAY');
    const templateIdx = prompt.indexOf('text_or_graphics_overlay');
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(templateIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeLessThan(templateIdx);
  });

  it('cycles aspect ratio 1:1 / 4:5 / 9:16 by index', () => {
    expect(renderNanoBananaPrompt(copy, 0)).toMatch(/Aspect ratio: 1:1/);
    expect(renderNanoBananaPrompt(copy, 1)).toMatch(/Aspect ratio: 4:5/);
    expect(renderNanoBananaPrompt(copy, 2)).toMatch(/Aspect ratio: 9:16/);
    expect(renderNanoBananaPrompt(copy, 3)).toMatch(/Aspect ratio: 1:1/);
  });

  it('instructs Gemini to ignore reference image text', () => {
    const prompt = renderNanoBananaPrompt(copy, 0);
    expect(prompt).toMatch(/do NOT use any text from the reference image/);
  });
});

describe('parseVariantsArray — Bug 2: copy must be parseable from Claude', () => {
  it('returns headline + primary_text + description fields the job persists', () => {
    const result = parseVariantsArray(
      {
        variants: [
          {
            variant_index: 0,
            intensity_level: 'medium',
            headline: 'New angle',
            primary_text: 'Fresh perspective on the same offer.',
            description: 'Skeptic reframes the pitch.',
            rationale: 'shift the entry point',
          },
        ],
      },
      1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variants[0]).toMatchObject({
      headline: 'New angle',
      primary_text: 'Fresh perspective on the same offer.',
      description: 'Skeptic reframes the pitch.',
    });
  });

  it('rejects when Claude returns a variant missing headline', () => {
    const result = parseVariantsArray(
      { variants: [{ primary_text: 'has text but no headline' }] },
      1,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when the variants array is empty', () => {
    const result = parseVariantsArray({ variants: [] }, 3);
    expect(result.ok).toBe(false);
  });

  it('rejects when the response is not the expected shape', () => {
    const result = parseVariantsArray({ not_variants: [] }, 3);
    expect(result.ok).toBe(false);
  });
});
