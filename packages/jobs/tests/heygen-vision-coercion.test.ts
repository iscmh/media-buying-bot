/**
 * Polish-26.0.10 Commit 62: coercion + diagnostic parser tests.
 *
 * Failure mode this defends against: HeyGen sync circuit-breaker
 * tripped at chunk 44 (out of ~106) after 20 consecutive "JSON did
 * not match schema" failures from Gemini. Two problems:
 *
 *   1. Strict Zod rejected common Gemini drift (south_asian for
 *      ethnicity, grey for hair_color, numeric age, "office" for
 *      background_setting) — all equivalent labels the matcher
 *      would have handled fine.
 *   2. The failure signature was the constant string "JSON did not
 *      match schema", so 20 distinct drift patterns collapsed to
 *      one bucket and tripped the breaker in ~20 chunks — capping
 *      the pool at 422 avatars of the ~1264 live.
 *
 * Fix: parseMakeugcAvatarVisionAnalysisWithDiagnostics
 *   - tries strict Zod first
 *   - on fail, tries a mapping-table coercion pass
 *   - on still-fail, returns a diagnostic with per-field failure
 *     detail so the caller can emit a per-drift-pattern signature
 *
 * Coercion is CONSERVATIVE — only unambiguous equivalents get
 * mapped; unknown values still fail so the operator sees them.
 */
import { describe, expect, it } from 'vitest';
import {
  parseMakeugcAvatarVisionAnalysisWithDiagnostics,
  type MakeugcAvatarVisionAnalysis,
} from '../src/lib/makeugc-avatar-vision-prompt';

const clean: MakeugcAvatarVisionAnalysis = {
  age_bucket: '40s',
  ethnicity: 'white',
  hair_color: 'brown',
  hair_style: 'short pompadour',
  facial_hair: 'beard',
  wardrobe_style: 'business_casual',
  wardrobe_summary: 'navy blue blazer over white t-shirt',
  background_setting: 'indoor_office',
  confidence_note: '',
};

describe('parseMakeugcAvatarVisionAnalysisWithDiagnostics — strict path', () => {
  it('accepts a strictly-valid analysis unchanged', () => {
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics(clean);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.analysis).toEqual(clean);
      expect(r.coercionsApplied).toEqual([]);
    }
  });
});

describe('parseMakeugcAvatarVisionAnalysisWithDiagnostics — coercion path', () => {
  it('coerces ethnicity drift: south_asian -> asian', () => {
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      ethnicity: 'south_asian',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.analysis.ethnicity).toBe('asian');
      expect(r.coercionsApplied.some((c) => c.includes('ethnicity'))).toBe(true);
    }
  });

  it('coerces ethnicity drift: caucasian -> white, african_american -> black', () => {
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, ethnicity: 'caucasian' });
    expect(a.ok && a.analysis.ethnicity).toBe('white');
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      ethnicity: 'african_american',
    });
    expect(b.ok && b.analysis.ethnicity).toBe('black');
  });

  it('coerces hair_color drift: grey -> gray, blond -> blonde, salt-and-pepper -> gray', () => {
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, hair_color: 'grey' });
    expect(a.ok && a.analysis.hair_color).toBe('gray');
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, hair_color: 'blond' });
    expect(b.ok && b.analysis.hair_color).toBe('blonde');
    const c = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      hair_color: 'salt-and-pepper',
    });
    expect(c.ok && c.analysis.hair_color).toBe('gray');
  });

  it('coerces numeric age -> bucket (45 -> 40s, 72 -> 70s, 85 -> 80s+)', () => {
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, age_bucket: '45' });
    expect(a.ok && a.analysis.age_bucket).toBe('40s');
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, age_bucket: '72' });
    expect(b.ok && b.analysis.age_bucket).toBe('70s');
    const c = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, age_bucket: '85' });
    expect(c.ok && c.analysis.age_bucket).toBe('80s+');
  });

  it('coerces age range "40-49" -> 40s', () => {
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, age_bucket: '40-49' });
    expect(r.ok && r.analysis.age_bucket).toBe('40s');
  });

  it('coerces age word aliases: elderly -> 70s, middle-aged -> 40s', () => {
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, age_bucket: 'elderly' });
    expect(a.ok && a.analysis.age_bucket).toBe('70s');
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      age_bucket: 'middle-aged',
    });
    expect(b.ok && b.analysis.age_bucket).toBe('40s');
  });

  it('coerces facial_hair: none -> clean_shaven, moustache -> mustache, "clean shaven" -> clean_shaven', () => {
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({ ...clean, facial_hair: 'none' });
    expect(a.ok && a.analysis.facial_hair).toBe('clean_shaven');
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      facial_hair: 'moustache',
    });
    expect(b.ok && b.analysis.facial_hair).toBe('mustache');
    const c = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      facial_hair: 'clean shaven',
    });
    expect(c.ok && c.analysis.facial_hair).toBe('clean_shaven');
  });

  it('coerces wardrobe_style: smart casual -> business_casual, sporty -> athletic', () => {
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      wardrobe_style: 'smart casual',
    });
    expect(a.ok && a.analysis.wardrobe_style).toBe('business_casual');
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      wardrobe_style: 'sporty',
    });
    expect(b.ok && b.analysis.wardrobe_style).toBe('athletic');
  });

  it('coerces background_setting: office -> indoor_office, kitchen -> indoor_home, outside -> outdoor', () => {
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      background_setting: 'office',
    });
    expect(a.ok && a.analysis.background_setting).toBe('indoor_office');
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      background_setting: 'kitchen',
    });
    expect(b.ok && b.analysis.background_setting).toBe('indoor_home');
    const c = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      background_setting: 'outside',
    });
    expect(c.ok && c.analysis.background_setting).toBe('outdoor');
  });

  it('coerces background_setting: plain -> neutral, green screen -> studio', () => {
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      background_setting: 'plain',
    });
    expect(a.ok && a.analysis.background_setting).toBe('neutral');
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      background_setting: 'green screen',
    });
    expect(b.ok && b.analysis.background_setting).toBe('studio');
  });

  it('truncates over-long hair_style (max 80) and wardrobe_summary (max 200)', () => {
    const longHair = 'a'.repeat(120);
    const longWardrobe = 'b'.repeat(300);
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      hair_style: longHair,
      wardrobe_summary: longWardrobe,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.analysis.hair_style.length).toBe(80);
      expect(r.analysis.wardrobe_summary.length).toBe(200);
    }
  });

  it('fills empty confidence_note when field missing entirely', () => {
    const { confidence_note: _unused, ...withoutNote } = clean;
    void _unused;
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics(withoutNote);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.analysis.confidence_note).toBe('');
  });

  it('reports coercionsApplied so operator can spot drift patterns', () => {
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      ethnicity: 'caucasian',
      hair_color: 'grey',
      background_setting: 'office',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.coercionsApplied.length).toBeGreaterThanOrEqual(3);
      const combined = r.coercionsApplied.join(' | ');
      expect(combined).toMatch(/ethnicity/);
      expect(combined).toMatch(/hair_color/);
      expect(combined).toMatch(/background_setting/);
    }
  });
});

describe('parseMakeugcAvatarVisionAnalysisWithDiagnostics — hard-fail path', () => {
  it('returns a diagnostic when raw is not an object', () => {
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics('not an object');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.signature).toBe('schema:not-object');
      expect(r.failure.rawSnapshot.length).toBeGreaterThan(0);
    }
  });

  it('returns a diagnostic when raw is an array', () => {
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.signature).toBe('schema:not-object');
  });

  it('returns a diagnostic naming the failing field when a value is not coercible', () => {
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      ethnicity: 'martian',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.signature).toBe('schema:ethnicity');
      expect(r.failure.reason).toMatch(/ethnicity/);
      expect(r.failure.fieldIssues.some((s) => s.includes('martian'))).toBe(true);
    }
  });

  it('splits signatures by which field(s) drifted so circuit-breaker does not collapse patterns', () => {
    // The pre-Commit-62 bug was that ALL schema-fails hashed to one
    // signature ("json did not match schema"), tripping the breaker
    // in 20 consecutive chunks. Post-fix: two different drift patterns
    // produce two different signatures.
    const a = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      ethnicity: 'martian',
    });
    const b = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      background_setting: 'mars',
    });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.failure.signature).not.toBe(b.failure.signature);
    }
  });

  it('surfaces the raw JSON snapshot on hard-fail so operator sees what Gemini emitted', () => {
    const raw = { ...clean, ethnicity: 'martian', extra: 'whatever' };
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.rawSnapshot).toContain('martian');
    }
  });

  it('caps rawSnapshot to 400 chars to keep step output small', () => {
    const bigNote = 'x'.repeat(2000);
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      ...clean,
      ethnicity: 'martian',
      confidence_note: bigNote,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.rawSnapshot.length).toBeLessThanOrEqual(400);
  });
});

describe('parseMakeugcAvatarVisionAnalysisWithDiagnostics — real-world drift patterns from the operator failure family', () => {
  it('recovers the operator-suspected chunk-44 drift shape: south_asian + grey + numeric age + office', () => {
    // Composite of the most-likely drift patterns hitting HeyGen sync
    // circuit-breaker at chunk 44+. Post-fix, this analysis parses
    // cleanly instead of being one of the 20 consecutive "JSON did
    // not match schema" hits that tripped the breaker.
    const r = parseMakeugcAvatarVisionAnalysisWithDiagnostics({
      age_bucket: '35',
      ethnicity: 'south_asian',
      hair_color: 'grey',
      hair_style: 'short wavy',
      facial_hair: 'clean shaven',
      wardrobe_style: 'business casual',
      wardrobe_summary: 'navy blazer, no tie',
      background_setting: 'office',
      confidence_note: '',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.analysis).toEqual({
        age_bucket: '30s',
        ethnicity: 'asian',
        hair_color: 'gray',
        hair_style: 'short wavy',
        facial_hair: 'clean_shaven',
        wardrobe_style: 'business_casual',
        wardrobe_summary: 'navy blazer, no tie',
        background_setting: 'indoor_office',
        confidence_note: '',
      });
      // 6 coercions applied (age, ethnicity, hair_color, facial_hair,
      // wardrobe_style, background_setting).
      expect(r.coercionsApplied.length).toBeGreaterThanOrEqual(6);
    }
  });
});
