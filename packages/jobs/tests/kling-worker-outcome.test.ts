/**
 * Polish-9.7 / 9.8 / 9.9: Kling worker fail-fast outcome + production-
 * manual parser tests. The parser handles the Universal UGC Master
 * Prompt's actual output format — Section C blocks delimited by `─────`
 * separators with `CLIP N — TIME — TITLE` or `SCENE N — ...` headers
 * containing `[USE IMAGE X AS STARTING FRAME]`, `Subject:`, and
 * `[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "..."`
 * directives that Kling 3.0 consumes natively.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideKlingJobOutcome,
  parseProductionManual,
} from '../src/functions/generate-kling-multi-clip-variants';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FORGE_FIXTURE = readFileSync(
  resolve(__dirname, '../../ai-providers/src/prompts/examples/forge-tallow-balm-dr-marcus.md'),
  'utf8',
);

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

describe('Polish-9.9: parseProductionManual — Forge fixture (gold standard)', () => {
  it('parses 16 clips with Section A/B/C fields populated', () => {
    const r = parseProductionManual(FORGE_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.manual.characterPrompt).toMatch(/three-view character sheet/i);
    expect(r.manual.characterPrompt).toMatch(/olive army-green V-neck medical scrubs/i);
    expect(r.manual.setPrompt).toMatch(/medical office\/exam room/i);
    expect(r.manual.clips).toHaveLength(16);
  });

  it('clip 0 has exact Forge dialogue + [USE IMAGE 1] anchor + 6s duration + lip-sync motion', () => {
    const r = parseProductionManual(FORGE_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const clip0 = r.manual.clips[0]!;
    expect(clip0.clipNumber).toBe(1);
    expect(clip0.dialogue).toBe(
      "Your skin care routine might be the reason you're aging faster, and here's why.",
    );
    expect(clip0.videoPrompt).toMatch(/\[USE IMAGE 1 AS STARTING FRAME\]/);
    expect(clip0.videoPrompt).toMatch(/Subject: DR\. MARCUS, ref: 284/);
    expect(clip0.videoPrompt).toMatch(/GENERATE NATIVE AUDIO AND LIP-SYNC/);
    expect(clip0.videoPrompt).toMatch(/Static iPhone shot\./);
    expect(clip0.duration).toBe(6);
    expect(clip0.motionType).toBe('lip-sync');
    expect(clip0.startingFrameImage).toBe(1);
  });

  it('clip 1 has the "75% of anti-aging products" dialogue', () => {
    const r = parseProductionManual(FORGE_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const clip1 = r.manual.clips[1]!;
    expect(clip1.clipNumber).toBe(2);
    expect(clip1.dialogue).toMatch(/Over 75% of anti-aging products/);
    expect(clip1.videoPrompt).toMatch(/\[USE IMAGE 2 AS STARTING FRAME\]/);
    expect(clip1.startingFrameImage).toBe(2);
  });

  it('clip 15 (final CTA) preserves the "Click below" dialogue + 5s duration', () => {
    const r = parseProductionManual(FORGE_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const last = r.manual.clips[15]!;
    expect(last.clipNumber).toBe(16);
    expect(last.dialogue).toMatch(/Click below before we sell out/);
    expect(last.duration).toBe(5);
  });

  it('every clip has a non-empty videoPrompt populated with directive text', () => {
    const r = parseProductionManual(FORGE_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    for (const clip of r.manual.clips) {
      expect(clip.videoPrompt.length).toBeGreaterThan(50);
      expect(clip.videoPrompt).toMatch(/\[USE IMAGE \d+ AS STARTING FRAME\]/);
    }
  });

  it('imagePrompt is populated for every clip (master prompt fallback at minimum)', () => {
    const r = parseProductionManual(FORGE_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Clip 1 should pull the IMAGE 1 master first frame; clips 2-16 either
    // get the per-image continuation snippet or the master fallback.
    expect(r.manual.clips[0]!.imagePrompt).toBeTruthy();
    expect(r.manual.clips[0]!.imagePrompt).toMatch(/photorealistic/i);
  });
});

describe('Polish-9.9: parseProductionManual — also accepts SCENE keyword (master prompt spec)', () => {
  it('CLIP and SCENE headers are both parsed', () => {
    const md = `# COMPLETE VIDEO PRODUCTION MANUAL

SECTION A — CHARACTER & SET GENERATION
Global Character Prompt: A 30yo woman in a sunny kitchen.
Global Set Prompt: Sunny morning kitchen with messy counter.

SECTION B — FIRST FRAMES (IMAGE PROMPTS)
IMAGE 1 — Master First Frame:
Generate a photorealistic image of a 30yo woman in a kitchen.

SECTION C — ANIMATION & NATIVE AUDIO PROMPTS

─────────────────────────────────────────
SCENE 1 — 00:00–00:06 — HOOK
Starting Frame: Image 1
Last Frame needed: YES
─────────────────────────────────────────
[USE IMAGE 1 AS STARTING FRAME]
Subject: SARAH, ref: 123, a 30yo woman, warm American accent.
[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Morning!"
Static iPhone shot. Sarah holds mug, smiles.
─────────────────────────────────────────
motionType: lip-sync
`;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual.clips).toHaveLength(1);
    expect(r.manual.clips[0]!.dialogue).toBe('Morning!');
    expect(r.manual.clips[0]!.videoPrompt).toMatch(/\[USE IMAGE 1 AS STARTING FRAME\]/);
  });
});

describe('Polish-9.9: parseProductionManual — error paths', () => {
  it('null/undefined input → ok=false', () => {
    const r = parseProductionManual(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no text/i);
  });

  it('missing Section A character prompt → ok=false with characterPrompt error', () => {
    const md = `SECTION A — CHARACTER & SET GENERATION
Global Set Prompt: A sunny kitchen.

SECTION C — ANIMATION & NATIVE AUDIO PROMPTS

─────────────────────────────────────────
CLIP 1 — 00:00–00:06 — HOOK
Starting Frame: Image 1
─────────────────────────────────────────
[USE IMAGE 1 AS STARTING FRAME]
Static iPhone shot.
─────────────────────────────────────────
motionType: lip-sync
`;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing characterPrompt/i);
  });

  it('missing Section C entirely → ok=false', () => {
    const md = `SECTION A — CHARACTER & SET GENERATION
Global Character Prompt: A 30yo woman.
Global Set Prompt: Sunny kitchen.

SECTION B — FIRST FRAMES
IMAGE 1 — Master First Frame:
A photorealistic image.
`;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/0 parseable clip blocks/i);
      expect(r.error).toMatch(/First 500 chars/);
    }
  });

  it('Section C present but no separators / CLIP headers → ok=false', () => {
    const md = `SECTION A — CHARACTER & SET GENERATION
Global Character Prompt: A 30yo woman.
Global Set Prompt: Sunny kitchen.

SECTION C — ANIMATION
Sure! I'll write the production manual for you. Lots of prose here. ${'a'.repeat(200)}
`;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/0 parseable clip blocks/i);
      expect(r.error).toMatch(/First 500 chars/);
    }
  });

  it('prose with no section structure at all → ok=false', () => {
    const prose =
      "Sure! I'll write the production manual for you. Here are the 16 clips: " + 'a'.repeat(2000);
    const r = parseProductionManual(prose);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing characterPrompt/i);
  });
});
