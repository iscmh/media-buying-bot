/**
 * Polish-9.7: Kling worker fail-fast outcome + parser hard-fail tests.
 * Polish-9.8: parser tests updated for markdown format (master prompt
 * spec) + JSON backwards-compat path.
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

describe('Polish-9.8: parseProductionManual — JSON backwards-compat path', () => {
  it('valid JSON object → ok=true with all fields', () => {
    const r = parseProductionManual({
      character_prompt: 'A 30yo woman in a kitchen',
      set_prompt: 'Sunny morning kitchen',
      clips: [
        { video_prompt: 'Hold mug, smile.', dialogue: 'Morning!', duration: 6 },
        { video_prompt: 'Pour coffee, sip.', dialogue: 'Mmm.' },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.clips).toHaveLength(2);
      expect(r.manual.characterPrompt).toMatch(/30yo woman/);
      expect(r.manual.clips[0]!.duration).toBe(6);
    }
  });

  it('JSON wrapped in ```json fences → ok=true', () => {
    const manual = {
      character_prompt: 'C',
      set_prompt: 'S',
      clips: [{ video_prompt: 'one clip' }],
    };
    const text = '```json\n' + JSON.stringify(manual) + '\n```';
    const r = parseProductionManual(text);
    expect(r.ok).toBe(true);
  });

  it('JSON object with empty clips array → ok=false', () => {
    const r = parseProductionManual({
      character_prompt: 'C',
      set_prompt: 'S',
      clips: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/0 clips/i);
  });

  it('null/undefined → ok=false', () => {
    const r = parseProductionManual(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/neither JSON nor text/);
  });
});

describe('Polish-9.8: parseProductionManual — markdown (master prompt) path', () => {
  it('normalized "## SECTION / **Field:**" format → 16 clips parsed cleanly', () => {
    const md = buildMarkdownFixture(16);
    const r = parseProductionManual(md, { expectedClips: 16 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.clips).toHaveLength(16);
      expect(r.manual.characterPrompt).toMatch(/Dr\. Marcus/);
      expect(r.manual.setPrompt).toMatch(/medical office/);
      const first = r.manual.clips[0]!;
      expect(first.videoPrompt).toMatch(/hook delivery/i);
      expect(first.dialogue).toMatch(/skin care routine/);
      expect(first.duration).toBe(6);
      expect(first.imagePrompt).toMatch(/photorealistic/i);
      expect(first.motionType).toBe('lip-sync');
    }
  });

  it('missing Global Character Prompt → ok=false with specific error', () => {
    const md = `# MANUAL

## SECTION A — CHARACTER & SET GENERATION

**Global Set Prompt:** A sunny kitchen.

## SECTION C — POST-PRODUCTION

### Clip 1
**Video Prompt:** Hold mug.
`;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing characterPrompt/i);
  });

  it('missing Global Set Prompt → ok=false', () => {
    const md = `## SECTION A

**Global Character Prompt:** A woman.

## SECTION C

### Clip 1
**Video Prompt:** Hold mug.
`;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing setPrompt/i);
  });

  it('only 8 clips when 16 expected → ok=false with "8 clips, expected 16"', () => {
    const md = buildMarkdownFixture(8);
    const r = parseProductionManual(md, { expectedClips: 16 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/8 clips, expected 16/);
  });

  it('prose with no section structure → ok=false with first-500-chars excerpt', () => {
    const prose =
      "Sure! I'll write the production manual for you. Here are the 16 clips: " + 'a'.repeat(2000);
    const r = parseProductionManual(prose);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/First 500 chars/);
      expect(r.error).toContain("I'll write the production manual");
    }
  });

  it('Forge fixture (real master-prompt example) → 16 clips with character + dialogues', () => {
    const fixturePath = resolve(
      __dirname,
      '../../ai-providers/src/prompts/examples/forge-tallow-balm-dr-marcus.md',
    );
    const md = readFileSync(fixturePath, 'utf8');
    const r = parseProductionManual(md, { expectedClips: 16 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.clips).toHaveLength(16);
      expect(r.manual.characterPrompt).toMatch(/three-view character sheet/i);
      expect(r.manual.setPrompt).toMatch(/medical office/i);
      // Clip 1 from Forge has the "skin care routine" dialogue.
      expect(r.manual.clips[0]!.dialogue).toMatch(/skin care routine/i);
      // Clip 1's video prompt should contain the [USE IMAGE 1] anchor.
      expect(r.manual.clips[0]!.videoPrompt).toMatch(/USE IMAGE 1 AS STARTING FRAME/);
      // Forge uses 6s clips for #1-15 (derived from timestamps).
      expect(r.manual.clips[0]!.duration).toBe(6);
      // motionType is on its own line in Forge.
      expect(r.manual.clips[0]!.motionType).toBe('lip-sync');
      // Clip 16 is the final CTA.
      expect(r.manual.clips[15]!.dialogue).toMatch(/sell out/i);
    }
  });
});

/** Build a synthetic 16-clip markdown manual in the "## / **Field:**" normalized format. */
function buildMarkdownFixture(clipCount: number): string {
  const head = `# COMPLETE VIDEO PRODUCTION MANUAL: FORGE TALLOW BALM — Dr. Marcus

## SECTION A — CHARACTER & SET GENERATION

**Global Character Prompt:** Photorealistic three-view character sheet of Dr. Marcus, a man in his mid-30s, medium-dark olive complexion, short tight dark curly hair, clean-shaven, warm brown eyes, wearing olive army-green V-neck medical scrubs with white cursive embroidery.

**Global Set Prompt:** Indoor medical office/exam room environment. Off-white clinical walls, drop ceiling tiles visible at top of frame. Behind subject: chrome otoscope, doctor bobblehead figurine, dermatology skin sample display board.

## SECTION B — FIRST FRAMES

`;
  let body = '## SECTION C — CLIP-BY-CLIP BREAKDOWN\n\n';
  for (let i = 1; i <= clipCount; i++) {
    const start = `00:${String(((i - 1) * 6) % 60).padStart(2, '0')}`;
    const end = `00:${String((i * 6) % 60).padStart(2, '0')}`;
    body += `### Clip ${i}\n`;
    body += `**Image Prompt:** Generate a photorealistic image of Dr. Marcus, clip ${i}, holding microphone, eye-level shot, clinical office background.\n`;
    body += `**Video Prompt:** Static iPhone shot. Hook delivery for clip ${i}. Timestamp ${start}-${end}. Authentic UGC, no filter.\n`;
    if (i === 1) {
      body += `**Dialogue:** "Your skin care routine might be the reason you're aging faster, and here's why."\n`;
    } else {
      body += `**Dialogue:** "Clip ${i} dialogue line."\n`;
    }
    body += `**Duration:** 6s\n`;
    body += `**Motion Type:** lip-sync\n\n`;
  }
  return head + body;
}
