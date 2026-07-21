/**
 * Polish-25 Commit 7 regression pins — vision prompt + schema.
 *
 * Matcher tests live in packages/ai-providers/tests/
 * makeugc-avatar-vision.test.ts. This file pins:
 *   - MakeugcAvatarVisionAnalysisSchema Zod round-trip
 *   - Closed enum sizes (any expansion needs a data migration)
 *   - System prompt anchors (operator-tuned wording)
 */
import { describe, expect, it } from 'vitest';
import {
  MakeugcAvatarVisionAnalysisSchema,
  MAKEUGC_AGE_BUCKETS,
  MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT,
  MAKEUGC_ETHNICITIES,
  MAKEUGC_FACIAL_HAIRS,
  MAKEUGC_HAIR_COLORS,
  MAKEUGC_WARDROBE_STYLES,
  parseMakeugcAvatarVisionAnalysis,
} from '../src/lib/makeugc-avatar-vision-prompt';

const clean = {
  age_bucket: '60s',
  ethnicity: 'white',
  hair_color: 'gray',
  hair_style: 'short salt-and-pepper',
  facial_hair: 'clean_shaven',
  wardrobe_style: 'business_casual',
  wardrobe_summary: 'navy blue polo shirt',
  background_setting: 'studio',
  confidence_note: '',
};

describe('Polish-25 Commit 7: MakeugcAvatarVisionAnalysisSchema round-trip', () => {
  it('accepts a fully-populated valid analysis object', () => {
    expect(MakeugcAvatarVisionAnalysisSchema.safeParse(clean).success).toBe(true);
    expect(parseMakeugcAvatarVisionAnalysis(clean)).not.toBeNull();
  });

  it('rejects age_bucket outside the closed enum', () => {
    expect(
      MakeugcAvatarVisionAnalysisSchema.safeParse({ ...clean, age_bucket: '55s' }).success,
    ).toBe(false);
    expect(parseMakeugcAvatarVisionAnalysis({ ...clean, age_bucket: '55s' })).toBeNull();
  });

  it('rejects ethnicity outside the closed enum', () => {
    expect(
      MakeugcAvatarVisionAnalysisSchema.safeParse({ ...clean, ethnicity: 'made-up-group' }).success,
    ).toBe(false);
  });

  it('rejects hair_color outside the closed enum', () => {
    expect(
      MakeugcAvatarVisionAnalysisSchema.safeParse({ ...clean, hair_color: 'rainbow' }).success,
    ).toBe(false);
  });

  it('rejects facial_hair outside the closed enum', () => {
    expect(
      MakeugcAvatarVisionAnalysisSchema.safeParse({ ...clean, facial_hair: 'sideburns' }).success,
    ).toBe(false);
  });

  it('rejects empty hair_style / wardrobe_summary', () => {
    expect(MakeugcAvatarVisionAnalysisSchema.safeParse({ ...clean, hair_style: '' }).success).toBe(
      false,
    );
    expect(
      MakeugcAvatarVisionAnalysisSchema.safeParse({ ...clean, wardrobe_summary: '' }).success,
    ).toBe(false);
  });

  it('accepts confidence_note as non-empty string (guess flagged)', () => {
    expect(
      MakeugcAvatarVisionAnalysisSchema.safeParse({
        ...clean,
        confidence_note: 'could be 20s or 30s — ambiguous lighting',
      }).success,
    ).toBe(true);
  });

  it('returns null on parseMakeugcAvatarVisionAnalysis for a partial object', () => {
    const partial = { age_bucket: '60s' };
    expect(parseMakeugcAvatarVisionAnalysis(partial)).toBeNull();
  });
});

describe('Polish-25 Commit 7: closed-enum sizes locked (data-migration tripwire)', () => {
  it('exports 7 age buckets', () => {
    expect(MAKEUGC_AGE_BUCKETS.length).toBe(7);
  });
  it('exports 8 ethnicity buckets', () => {
    expect(MAKEUGC_ETHNICITIES.length).toBe(8);
  });
  it('exports 8 hair-color buckets', () => {
    expect(MAKEUGC_HAIR_COLORS.length).toBe(8);
  });
  it('exports 5 facial-hair buckets', () => {
    expect(MAKEUGC_FACIAL_HAIRS.length).toBe(5);
  });
  it('exports 6 wardrobe-style buckets', () => {
    expect(MAKEUGC_WARDROBE_STYLES.length).toBe(6);
  });
});

describe('Polish-25 Commit 7: MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT anchors', () => {
  const p = MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT;
  it('demands strict JSON output', () => {
    expect(p).toContain('STRUCTURED JSON');
    expect(p).toContain('Return ONLY');
  });
  it('lists every field required', () => {
    expect(p).toContain('age_bucket');
    expect(p).toContain('ethnicity');
    expect(p).toContain('hair_color');
    expect(p).toContain('hair_style');
    expect(p).toContain('facial_hair');
    expect(p).toContain('wardrobe_style');
    expect(p).toContain('wardrobe_summary');
    expect(p).toContain('background_setting');
    expect(p).toContain('confidence_note');
  });
  it('pins the defensive-defaults rule (never emit incomplete JSON)', () => {
    expect(p).toContain('DEFENSIVE DEFAULTS');
    expect(p).toContain('best-effort classification');
  });
});
