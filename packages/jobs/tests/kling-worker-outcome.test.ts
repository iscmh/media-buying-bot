/**
 * Polish-9.7 / 9.8 / 9.9 / 9.10: Kling worker fail-fast outcome +
 * production-manual parser tests. Polish-9.10 anchors clip parsing on
 * the [USE IMAGE X AS STARTING FRAME] directive — the only thing the
 * master prompt mandates Claude emit verbatim — instead of chasing
 * markdown decoration variants.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildImagePromptForClip,
  continuationImagePrompt,
  decideKlingJobOutcome,
  extractWardrobeFromCharacter,
  parseProductionManual,
  stripCharacterSheetPattern,
} from '../src/functions/generate-kling-multi-clip-variants';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FORGE_FIXTURE = readFileSync(
  resolve(__dirname, '../../ai-providers/src/prompts/examples/forge-tallow-balm-dr-marcus.md'),
  'utf8',
);

const COMMON_PREAMBLE = `# COMPLETE VIDEO PRODUCTION MANUAL

SECTION A — CHARACTER & SET GENERATION
Global Character Prompt: A 30yo woman in a sunny kitchen, dark hair, casual t-shirt.
Global Set Prompt: Sunny morning kitchen with messy counter, tangled charger cables.

SECTION B — FIRST FRAMES (IMAGE PROMPTS)
Some image guidance text that varies in format and we just capture it whole.

`;

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

describe('Polish-9.10: parseProductionManual — Forge fixture (gold standard)', () => {
  it('parses 16 clips with Section A populated and dialogues preserved', () => {
    const r = parseProductionManual(FORGE_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual.characterPrompt).toMatch(/three-view character sheet/i);
    expect(r.manual.setPrompt).toMatch(/medical office\/exam room/i);
    expect(r.manual.clips).toHaveLength(16);
    expect(r.manual.clips[0]!.dialogue).toBe(
      "Your skin care routine might be the reason you're aging faster, and here's why.",
    );
    expect(r.manual.clips[0]!.videoPrompt).toMatch(/\[USE IMAGE 1 AS STARTING FRAME\]/);
    expect(r.manual.clips[0]!.videoPrompt).toMatch(/Subject: DR\. MARCUS, ref: 284/);
    expect(r.manual.clips[0]!.duration).toBe(6);
    expect(r.manual.clips[0]!.motionType).toBe('lip-sync');
    expect(r.manual.clips[1]!.dialogue).toMatch(/Over 75% of anti-aging products/);
    expect(r.manual.clips[15]!.dialogue).toMatch(/Click below before we sell out/);
  });

  it('imageGuidance captures Section B body whole', () => {
    const r = parseProductionManual(FORGE_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual.imageGuidance).toMatch(/Master First Frame/i);
    expect(r.manual.imageGuidance).toMatch(/Same-Scene Continuations/i);
  });
});

describe('Polish-9.10: parseProductionManual — markdown-decoration-agnostic', () => {
  it('### CLIP 1 markdown headers + [USE IMAGE 1] directives → 16 clips parsed', () => {
    const md = COMMON_PREAMBLE + 'SECTION C — ANIMATION\n\n' + buildClips16('### CLIP');
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual.clips).toHaveLength(16);
    expect(r.manual.clips[0]!.dialogue).toBe('Hook line for clip 1.');
    expect(r.manual.clips[5]!.startingFrameImage).toBe(6);
  });

  it('**CLIP 1** bold headers + [USE IMAGE 1] directives → 16 clips parsed', () => {
    const md = COMMON_PREAMBLE + 'SECTION C — ANIMATION\n\n' + buildClips16('**CLIP');
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual.clips).toHaveLength(16);
    expect(r.manual.clips[0]!.videoPrompt).toMatch(/\[USE IMAGE 1 AS STARTING FRAME\]/);
  });

  it('no clip headers at all, only [USE IMAGE X] directives separated by blank lines → still parses', () => {
    let body = 'SECTION C — ANIMATION\n\n';
    for (let i = 1; i <= 16; i++) {
      body += `[USE IMAGE ${i} AS STARTING FRAME]\n`;
      body += `Subject: SARAH, ref: 123, a 30yo woman, US accent, warm delivery.\n`;
      body += `[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Line for clip ${i}."\n`;
      body += `Static iPhone shot. Action for clip ${i}.\n\n`;
    }
    const r = parseProductionManual(COMMON_PREAMBLE + body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual.clips).toHaveLength(16);
    expect(r.manual.clips[7]!.dialogue).toBe('Line for clip 8.');
    expect(r.manual.clips[7]!.motionType).toBe('lip-sync'); // default
  });

  it('out-of-order directives → sorted ascending by image number', () => {
    let body = 'SECTION C — ANIMATION\n\n';
    for (const n of [3, 1, 2]) {
      body += `[USE IMAGE ${n} AS STARTING FRAME]\nLine ${n}\n\n`;
    }
    const r = parseProductionManual(COMMON_PREAMBLE + body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual.clips.map((c) => c.clipNumber)).toEqual([1, 2, 3]);
  });

  it('duplicate [USE IMAGE 1] anchors → first kept, rest discarded', () => {
    const body =
      'SECTION C — ANIMATION\n\n' +
      `[USE IMAGE 1 AS STARTING FRAME]\nFirst body.\n\n` +
      `[USE IMAGE 1 AS STARTING FRAME]\nDuplicate body should be dropped.\n\n` +
      `[USE IMAGE 2 AS STARTING FRAME]\nSecond clip body.\n`;
    const r = parseProductionManual(COMMON_PREAMBLE + body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual.clips).toHaveLength(2);
    expect(r.manual.clips[0]!.videoPrompt).toContain('First body.');
    expect(r.manual.clips[0]!.videoPrompt).not.toContain('Duplicate body');
  });
});

describe('Polish-9.10: parseProductionManual — error paths', () => {
  it('null/undefined input → ok=false', () => {
    const r = parseProductionManual(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no text/i);
  });

  it('missing Section A character prompt → ok=false', () => {
    const md = `SECTION A — CHARACTER & SET GENERATION
Global Set Prompt: A kitchen.

SECTION C — ANIMATION
[USE IMAGE 1 AS STARTING FRAME]
Body.
`;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing characterPrompt/i);
  });

  it('missing SECTION C header entirely → ok=false with First 1000 chars dump', () => {
    const md = `SECTION A — CHARACTER & SET GENERATION
Global Character Prompt: A 30yo woman.
Global Set Prompt: Sunny kitchen.

SECTION B — FIRST FRAMES
Lots of image guidance here but no section C anywhere.
`;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/No SECTION C header found/);
      expect(r.error).toMatch(/First 1000 chars/);
    }
  });

  it('Section C present but no [USE IMAGE X] directives → ok=false with diagnostic dump', () => {
    const md =
      COMMON_PREAMBLE +
      'SECTION C — ANIMATION\n\n' +
      "Sure! Here's the production manual: lots of prose without bracket directives. " +
      'a'.repeat(300);
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no \[USE IMAGE X AS STARTING FRAME\] directives/);
      expect(r.error).toMatch(/Section C first 2000 chars/);
      expect(r.error).toContain("Sure! Here's the production manual");
    }
  });
});

/**
 * Build 16 clip blocks using whatever per-clip header style is passed
 * (e.g. "### CLIP" or "**CLIP"). Always includes the [USE IMAGE N]
 * directive — that's what the parser actually anchors on.
 */
function buildClips16(headerStyle: string): string {
  let out = '';
  for (let i = 1; i <= 16; i++) {
    if (headerStyle === '**CLIP') {
      out += `**CLIP ${i} — 00:${pad((i - 1) * 6)}–00:${pad(i * 6)} — TITLE**\n`;
    } else {
      out += `${headerStyle} ${i} — 00:${pad((i - 1) * 6)}–00:${pad(i * 6)} — TITLE\n`;
    }
    out += `Starting Frame: Image ${i}\n\n`;
    out += `[USE IMAGE ${i} AS STARTING FRAME]\n`;
    out += `Subject: SARAH, ref: 123, a 30yo woman, US accent, warm delivery.\n`;
    out += `[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Hook line for clip ${i}."\n`;
    out += `Static iPhone shot. Action for clip ${i}.\n`;
    out += `motionType: lip-sync\n\n`;
  }
  return out;
}

function pad(n: number): string {
  return String(n % 60).padStart(2, '0');
}

describe('Polish-9.12: continuationImagePrompt (character-reference chain)', () => {
  it('frames the call as a same-scene continuation of Image 1', () => {
    const manual = {
      characterPrompt: 'A 30yo woman, dark hair, casual t-shirt.',
      setPrompt: 'Sunny morning kitchen with messy counter.',
    };
    const clip = {
      clipNumber: 2,
      startingFrameImage: 2,
      videoPrompt: 'Right hand raises mug, smile widens.',
      dialogue: 'Mmm!',
    };
    const out = continuationImagePrompt(manual, clip);
    expect(out).toMatch(/Exact same framing as Image 1/);
    expect(out).toMatch(/same character, same scene, same lighting/);
    expect(out).toMatch(/Now: Right hand raises mug/);
    expect(out).toMatch(/30yo woman/);
    expect(out).toMatch(/messy counter/);
    expect(out).toMatch(/Camera: same as Image 1/);
    expect(out).toMatch(/ABSOLUTELY NO phones/);
  });
});

describe('Polish-9.12: buildImagePromptForClip — clip 0 path', () => {
  it('returns character + set + videoPrompt joined (imageGuidance intentionally excluded by Polish-9.15)', () => {
    const manual = {
      characterPrompt: 'A 30yo woman.',
      setPrompt: 'A sunny kitchen.',
      imageGuidance: 'Photorealistic, no filters.',
    };
    const clip = {
      clipNumber: 1,
      startingFrameImage: 1,
      videoPrompt: '[USE IMAGE 1 AS STARTING FRAME] Hold mug.',
    };
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toContain('A 30yo woman.');
    expect(out).toContain('A sunny kitchen.');
    expect(out).toContain('Hold mug.');
    // imageGuidance is NOT included to keep Nano Banana from generating
    // multiple frames when Section B mentions "IMAGE 1, IMAGE 2, …".
    expect(out).not.toContain('Photorealistic, no filters.');
  });

  it('uses clip.imagePrompt directly when populated', () => {
    const manual = { characterPrompt: 'C', setPrompt: 'S' };
    const clip = {
      clipNumber: 1,
      startingFrameImage: 1,
      videoPrompt: 'V',
      imagePrompt: 'Pre-baked image prompt for this clip.',
    };
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toBe(
      'Single character, single view, NOT a character sheet, NOT a reference sheet, NOT multiple angles, NOT front/back/side views. Generate a single photorealistic UGC selfie-style frame. Camera: smartphone (iPhone) eye-level shot, vertical 9:16 portrait. Authentic UGC selfie aesthetic. NOT AI-generated looking. Ultra-realistic skin texture, natural pores. ONLY the single character described, in the single scene described.\n\nPre-baked image prompt for this clip.',
    );
  });
});

describe('Polish-9.15: stripCharacterSheetPattern', () => {
  it('removes the "photorealistic three-view character sheet" directive', () => {
    const input =
      'Photorealistic three-view character sheet, front view, side view, back view. Man, mid-30s, olive complexion, dark curly hair.';
    const out = stripCharacterSheetPattern(input);
    expect(out).not.toMatch(/three[\s-]view character sheet/i);
    expect(out).not.toMatch(/front view, side view, back view/i);
    expect(out).toMatch(/Man, mid-30s, olive complexion/);
  });

  it('handles the dashed "three-view" spelling', () => {
    const input =
      'Photorealistic three-view character sheet of John, a 67-year-old grandfather. Dark hair, beard.';
    const out = stripCharacterSheetPattern(input);
    expect(out).not.toMatch(/three-view character sheet/i);
    expect(out).toMatch(/Dark hair, beard\./);
  });

  it('rewrites bare "character sheet" → "character description"', () => {
    const input = 'A character sheet showing the actor in scrubs.';
    const out = stripCharacterSheetPattern(input);
    expect(out).toMatch(/character description/i);
    expect(out).not.toMatch(/character sheet/i);
  });

  it('preserves rest of character description and collapses whitespace', () => {
    const input =
      'Photorealistic three-view character sheet, front view, side view, back view. Mid-30s woman wearing blue scrubs. Warm brown eyes.';
    const out = stripCharacterSheetPattern(input);
    expect(out).toBe('Mid-30s woman wearing blue scrubs. Warm brown eyes.');
  });
});

describe('Polish-9.15: buildImagePromptForClip — clip 0 (UGC framing)', () => {
  const manual = {
    characterPrompt:
      'Photorealistic three-view character sheet, front view, side view, back view. Man, mid-30s, olive complexion, wearing olive army-green V-neck medical scrubs.',
    setPrompt: 'Indoor medical office. Off-white walls, drop ceiling tiles visible at top.',
    imageGuidance: 'IMAGE 1, IMAGE 2, IMAGE 3 ... continuations table follows.',
  };
  const clip = {
    clipNumber: 1,
    startingFrameImage: 1,
    videoPrompt: 'Static iPhone shot. Dr. Marcus holds microphone, eyebrows raised urgent.',
  };

  it('includes the UGC framing prefix', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toMatch(/Single character, single view, NOT a character sheet/);
    expect(out).toMatch(/UGC selfie-style/);
    expect(out).toMatch(/9:16 portrait/);
  });

  it('strips the three-view character sheet phrasing from clip 0 prompt', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).not.toMatch(/three[\s-]view character sheet/i);
    expect(out).not.toMatch(/front view, side view, back view/i);
  });

  it('does NOT include Section B imageGuidance (would confuse model into multi-image output)', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).not.toMatch(/IMAGE 1, IMAGE 2/);
    expect(out).not.toMatch(/continuations table/);
  });

  it('still preserves character description, set, and clip action', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toMatch(/Man, mid-30s, olive complexion/);
    expect(out).toMatch(/olive army-green V-neck medical scrubs/);
    expect(out).toMatch(/medical office/);
    expect(out).toMatch(/Static iPhone shot. Dr\. Marcus holds microphone/);
  });

  it('appends explicit single-frame guard at the end', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toMatch(/Generate ONE single frame from ONE camera angle/);
  });
});

describe('Polish-9.15: continuationImagePrompt — clips 1+ (wardrobe lock)', () => {
  const manual = {
    characterPrompt:
      'Photorealistic three-view character sheet, front view, side view, back view. Woman in her 30s, dark hair, wearing a blue cotton t-shirt.',
    setPrompt: 'Sunny morning kitchen with messy counter.',
  };
  const clip = {
    clipNumber: 2,
    startingFrameImage: 2,
    videoPrompt: 'Right hand raises mug, smile widens.',
  };

  it('includes UGC framing as defense in depth', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out).toMatch(/Single character, single view, NOT a character sheet/);
  });

  it('strips the three-view character sheet phrasing', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out).not.toMatch(/three[\s-]view character sheet/i);
  });

  it('locks wardrobe by repeating clothing description verbatim', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out).toMatch(/Wardrobe: EXACTLY as in Image 1/);
    expect(out).toMatch(/blue cotton t-shirt/i);
    expect(out).toMatch(/Do NOT change clothing/);
  });

  it('keeps the same-framing / same-lighting anchor language', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out).toMatch(/Exact same framing as Image 1/);
    expect(out).toMatch(/Camera: same as Image 1/);
    expect(out).toMatch(/Lighting: same as Image 1/);
  });

  it('falls back to a generic wardrobe lock when no clothing cue is extractable', () => {
    const out = continuationImagePrompt(
      {
        characterPrompt: 'Person with brown eyes.',
        setPrompt: 'A room.',
      },
      clip,
    );
    expect(out).toMatch(/Wardrobe: EXACTLY as in Image 1/);
    expect(out).toMatch(/same clothing, same colors, same accessories/);
  });
});

describe('Polish-9.15: extractWardrobeFromCharacter', () => {
  it('extracts "wearing X" phrases', () => {
    expect(extractWardrobeFromCharacter('Mid-30s woman wearing blue scrubs.')).toBe('blue scrubs');
  });

  it('extracts "in a Y shirt" phrases', () => {
    expect(extractWardrobeFromCharacter('A 30yo woman in a red wool sweater.')).toBe(
      'red wool sweater',
    );
  });

  it('returns empty string when no clothing cue is present', () => {
    expect(extractWardrobeFromCharacter('Person with brown eyes.')).toBe('');
  });

  it('combines multiple cues with semicolons', () => {
    const out = extractWardrobeFromCharacter(
      'Man wearing olive army-green V-neck medical scrubs with white embroidery.',
    );
    expect(out).toMatch(/olive army-green V-neck medical scrubs/);
  });
});

describe('Polish-9.16: Section A — Global Prompt extraction tolerates markdown heading prefixes', () => {
  const sectionCBody =
    'SECTION C — ANIMATION\n\n' +
    '[USE IMAGE 1 AS STARTING FRAME]\n' +
    'Subject: SARAH, ref: 123, a 30yo woman.\n' +
    '[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Hi."\n' +
    'Static iPhone shot.\n';

  it('plain "Global Character Prompt:" (Forge style) still parses (regression)', () => {
    const md =
      `SECTION A — CHARACTER & SET GENERATION\n` +
      `Global Character Prompt: A 30yo woman with dark hair.\n` +
      `Global Set Prompt: Sunny morning kitchen.\n\n` +
      sectionCBody;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.characterPrompt).toBe('A 30yo woman with dark hair.');
      expect(r.manual.setPrompt).toBe('Sunny morning kitchen.');
    }
  });

  it('### **Global Character Prompt:** heading-bold (Claude production style) parses', () => {
    const md =
      `## **SECTION A — CHARACTER & SET GENERATION**\n\n` +
      `### **Global Character Prompt:**\n` +
      `A 30yo woman with dark hair, wearing a blue cotton t-shirt.\n\n` +
      `### **Global Set Prompt:**\n` +
      `Sunny morning kitchen with messy counter, tangled charger cables.\n\n` +
      sectionCBody;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.characterPrompt).toBe(
        'A 30yo woman with dark hair, wearing a blue cotton t-shirt.',
      );
      expect(r.manual.setPrompt).toBe(
        'Sunny morning kitchen with messy counter, tangled charger cables.',
      );
    }
  });

  it('## Global Character Prompt: heading (no bold) parses', () => {
    const md =
      `SECTION A — CHARACTER & SET GENERATION\n\n` +
      `## Global Character Prompt:\n` +
      `A 30yo woman.\n\n` +
      `## Global Set Prompt:\n` +
      `A sunny kitchen.\n\n` +
      sectionCBody;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.characterPrompt).toBe('A 30yo woman.');
      expect(r.manual.setPrompt).toBe('A sunny kitchen.');
    }
  });

  it('mixed: ### Global Character then plain Global Set → both extract', () => {
    const md =
      `SECTION A — CHARACTER & SET GENERATION\n\n` +
      `### **Global Character Prompt:**\n` +
      `A 30yo woman with dark hair.\n\n` +
      `Global Set Prompt: A sunny kitchen.\n\n` +
      sectionCBody;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.characterPrompt).toBe('A 30yo woman with dark hair.');
      expect(r.manual.setPrompt).toBe('A sunny kitchen.');
    }
  });

  it('no "Global Character Prompt" anywhere → ok=false with missing characterPrompt error', () => {
    const md =
      `SECTION A — CHARACTER & SET GENERATION\n\n` +
      `### **Global Set Prompt:** A sunny kitchen.\n\n` +
      sectionCBody;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing characterPrompt/i);
  });
});
