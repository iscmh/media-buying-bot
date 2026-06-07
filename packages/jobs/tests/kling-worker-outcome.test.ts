/**
 * Polish-9.7: Kling worker fail-fast + parser hard-fail tests. Covers
 * the silent-failure cases that let Polish-9.6 mark a 0-clip job
 * 'completed' and let a non-JSON Claude response silently build a
 * single bad clip.
 */
import { describe, expect, it } from 'vitest';
import {
  decideKlingJobOutcome,
  parseProductionManual,
} from '../src/functions/generate-kling-multi-clip-variants';

describe('Polish-9.7: decideKlingJobOutcome', () => {
  it('0 successes → fail with clear error', () => {
    const r = decideKlingJobOutcome({
      successCount: 0,
      totalClips: 16,
      clipsPerVariant: 16,
    });
    expect(r.kind).toBe('fail');
    if (r.kind === 'fail') {
      expect(r.error).toMatch(/All 16 clips failed/);
      expect(r.error).toMatch(/per-clip errors/);
    }
  });

  it('1 success out of 16 → complete with variantCount=1', () => {
    const r = decideKlingJobOutcome({
      successCount: 1,
      totalClips: 16,
      clipsPerVariant: 16,
    });
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(r.variantCount).toBe(1);
  });

  it('16 successes out of 16 → complete with variantCount=1', () => {
    const r = decideKlingJobOutcome({
      successCount: 16,
      totalClips: 16,
      clipsPerVariant: 16,
    });
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(r.variantCount).toBe(1);
  });

  it('17 successes (across 2 variants) → complete with variantCount=2', () => {
    const r = decideKlingJobOutcome({
      successCount: 17,
      totalClips: 32,
      clipsPerVariant: 16,
    });
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(r.variantCount).toBe(2);
  });
});

describe('Polish-9.7: parseProductionManual hard-fails on non-JSON', () => {
  it('non-JSON prose → ok=false with first-500-chars excerpt', () => {
    const prose =
      "Sure! I'll write the production manual for you. Here are the 16 clips: " + 'a'.repeat(2000);
    const r = parseProductionManual(prose);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/non-JSON manual/i);
      expect(r.error).toMatch(/First 500 chars/);
      expect(r.error).toContain("I'll write the production manual");
    }
  });

  it('non-object non-string input → ok=false', () => {
    const r = parseProductionManual(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/neither JSON nor text/);
  });

  it('valid JSON with clips[] → ok=true', () => {
    const manual = {
      character_prompt: 'A 30yo woman in a kitchen',
      set_prompt: 'Sunny morning kitchen',
      clips: [
        { video_prompt: 'Hold mug, smile.', dialogue: 'Morning!' },
        { video_prompt: 'Pour coffee, sip.', dialogue: 'Mmm.' },
      ],
    };
    const r = parseProductionManual(manual);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.clips).toHaveLength(2);
      expect(r.manual.characterPrompt).toMatch(/30yo woman/);
    }
  });

  it('valid JSON-as-text (fenced) → ok=true', () => {
    const manual = {
      character_prompt: 'C',
      set_prompt: 'S',
      clips: [{ video_prompt: 'one clip' }],
    };
    const text = '```json\n' + JSON.stringify(manual) + '\n```';
    const r = parseProductionManual(text);
    expect(r.ok).toBe(true);
  });

  it('empty clips array → ok=false with explicit error', () => {
    const r = parseProductionManual({
      character_prompt: 'C',
      set_prompt: 'S',
      clips: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No clips/i);
  });
});
