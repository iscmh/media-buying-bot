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
  buildKlingSubmitPrompt,
  continuationImagePrompt,
  decideKlingJobOutcome,
  extractContinuousDialogue,
  extractWardrobeFromCharacter,
  hasQuotedDialogue,
  IMAGE_UGC_HARD_DIRECTIVE,
  isSilentKlingModel,
  parseProductionManual,
  SILENT_UGC_HARD_DIRECTIVE,
  stripAudioEraArtifacts,
  stripCharacterSheetPattern,
  stripTextCaptionsBroll,
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
    // Polish-11.2: IMAGE_UGC_HARD_DIRECTIVE comes first, then
    // Polish-9.18 UGC_FRAMING, then the pre-baked imagePrompt.
    expect(out).toMatch(/^AMATEUR SMARTPHONE SELFIE PHOTO/);
    expect(out).toMatch(/Single character, single view, NOT a character sheet/);
    expect(out).toMatch(/AMATEUR SMARTPHONE SELFIE/);
    expect(out).toMatch(/Real human skin/);
    expect(out).toMatch(/\n\nPre-baked image prompt for this clip\.$/);
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

  it('includes the UGC framing prefix (Polish-9.18 amateur smartphone phrasing)', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toMatch(/Single character, single view, NOT a character sheet/);
    expect(out).toMatch(/AMATEUR SMARTPHONE SELFIE/);
    expect(out).toMatch(/9:16 portrait/);
    expect(out).toMatch(/Real human skin/);
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

  it('appends explicit single-frame + no-text guard at the end', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toMatch(/ONE single frame, ONE camera angle/);
    expect(out).toMatch(/NO text, NO captions, NO overlays/);
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

describe('Polish-13.1: parseProductionManual tolerant of Sonnet 4.6 formatting', () => {
  // Captures the surface variations Sonnet 4.6 emits that broke
  // the Sonnet-4-era parser:
  //   - "## SECTION A — ..." em-dash header (the existing slice already
  //     handles this, but we pin the contract here).
  //   - "### 🧍 GLOBAL CHARACTER PROMPT — \"NAME\"" subsection with
  //     emoji prefix + em-dash + quoted annotation, NO colon.
  //   - Prompt body inside a triple-backtick code block.
  //   - Preamble blocks (PRE-PRODUCTION NOTES, COMPLIANCE NOTE) before
  //     Section A that the parser must ignore, not error on.

  const sonnet46SectionA =
    `## SECTION A — CHARACTER & SET GENERATION\n` +
    `\n` +
    `### 🧍 GLOBAL CHARACTER PROMPT — "JOHN"\n` +
    `**Three-View Character Sheet — Photorealistic, Front / Side / Back:**\n` +
    `\n` +
    '```\n' +
    `Photorealistic three-view character sheet of a 42yo white American man named John, ` +
    `weathered tan skin, short brown hair with grey at the temples, three-day stubble, ` +
    `wearing a faded blue cotton t-shirt and jeans, casual home posture.\n` +
    '```\n' +
    `\n` +
    `### 🏠 GLOBAL SET PROMPT — "JOHN'S KITCHEN"\n` +
    `**Wide Establishing Shot, Photorealistic:**\n` +
    `\n` +
    '```\n' +
    `Sunny morning kitchen, oak cabinets, granite counter with a half-finished mug ` +
    `of coffee and a laptop showing a banking dashboard, soft natural window light.\n` +
    '```\n';

  const sonnet46SectionC =
    `## SECTION C — CLIP-BY-CLIP ANIMATION DIRECTIVES\n` +
    `\n` +
    `### CLIP 1\n` +
    `[USE IMAGE 1 AS STARTING FRAME]\n` +
    `Subject: JOHN, ref: 1, a 42yo man.\n` +
    `[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "I made wifi income."\n` +
    `Static iPhone shot.\n`;

  const sonnet46Preamble =
    `# COMPLETE VIDEO PRODUCTION MANUAL: WIFI INCOME TESTIMONIAL\n` +
    `\n` +
    `---\n` +
    `\n` +
    `> ⚠️ **PRE-PRODUCTION NOTES BEFORE PRODUCTION:**\n` +
    `> Read this entire manual before any image generation.\n` +
    `\n` +
    `---\n` +
    `\n` +
    `> 🚨 **COMPLIANCE NOTE BEFORE PRODUCTION:**\n` +
    `> Verify all claims with internal legal review.\n` +
    `\n` +
    `---\n` +
    `\n`;

  it('extracts characterPrompt + setPrompt from emoji/em-dash heading + code-block body', () => {
    const md = sonnet46Preamble + sonnet46SectionA + '\n' + sonnet46SectionC;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.characterPrompt).toMatch(/Photorealistic three-view character sheet/);
      expect(r.manual.characterPrompt).toMatch(/42yo white American man named John/);
      // Decoration label above the code block must NOT bleed in.
      expect(r.manual.characterPrompt).not.toMatch(/Three-View Character Sheet — Photorealistic/);
      // Closing/opening fences must NOT bleed in.
      expect(r.manual.characterPrompt).not.toMatch(/```/);
      expect(r.manual.setPrompt).toMatch(/Sunny morning kitchen/);
      expect(r.manual.setPrompt).toMatch(/oak cabinets/);
      expect(r.manual.setPrompt).not.toMatch(/Wide Establishing Shot/);
      expect(r.manual.setPrompt).not.toMatch(/```/);
      expect(r.manual.clips).toHaveLength(1);
    }
  });

  it('preamble blocks (PRE-PRODUCTION NOTES, COMPLIANCE NOTE) before Section A are ignored, not errored', () => {
    const md = sonnet46Preamble + sonnet46SectionA + '\n' + sonnet46SectionC;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
  });

  it('Set extraction stops at the next Global X Prompt subsection (no character-body bleed)', () => {
    const md = sonnet46Preamble + sonnet46SectionA + '\n' + sonnet46SectionC;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Character must not contain anything from the Set block.
      expect(r.manual.characterPrompt).not.toMatch(/oak cabinets/);
      expect(r.manual.characterPrompt).not.toMatch(/GLOBAL SET PROMPT/i);
      // Set must not contain anything from the Character block.
      expect(r.manual.setPrompt).not.toMatch(/weathered tan skin/);
    }
  });

  it('legacy colon form continues to work alongside the new heading form', () => {
    // Mixed: Character in Sonnet 4.6 heading form, Set in colon form.
    const md =
      `## SECTION A — CHARACTER & SET GENERATION\n` +
      `### 🧍 GLOBAL CHARACTER PROMPT — "JOHN"\n` +
      `**Sheet label:**\n` +
      `\n` +
      '```\n' +
      `Photorealistic 42yo man named John with weathered tan skin.\n` +
      '```\n' +
      `\n` +
      `Global Set Prompt: Sunny morning kitchen with oak cabinets.\n` +
      `\n` +
      sonnet46SectionC;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.characterPrompt).toMatch(/42yo man named John/);
      expect(r.manual.setPrompt).toBe('Sunny morning kitchen with oak cabinets.');
    }
  });

  it('falls back to raw body when no code block is present in the new heading form', () => {
    // Heading-only form, body as plain prose (no fenced block). The
    // parser should accept the body verbatim.
    const md =
      `## SECTION A — CHARACTER & SET GENERATION\n` +
      `### 🧍 GLOBAL CHARACTER PROMPT — "JANE"\n` +
      `A 30yo woman with dark hair, wearing a blue cotton t-shirt, sunny smile.\n` +
      `\n` +
      `### 🏠 GLOBAL SET PROMPT — "JANE'S KITCHEN"\n` +
      `Sunny morning kitchen with messy counter and tangled charger cables.\n` +
      `\n` +
      sonnet46SectionC;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.characterPrompt).toMatch(/30yo woman with dark hair/);
      expect(r.manual.setPrompt).toMatch(/Sunny morning kitchen with messy counter/);
    }
  });

  it('ignores a short / empty code block (defensive — could be a syntax sample, not the prompt)', () => {
    // A trivially-small fenced block (<50 chars) should NOT shadow the
    // surrounding prose; cleanPromptBody must fall through to raw body.
    const md =
      `## SECTION A\n` +
      `### 🧍 GLOBAL CHARACTER PROMPT — "JANE"\n` +
      `A 30yo woman with dark hair, wearing a blue cotton t-shirt.\n` +
      `Example tag: \`\`\`\nshort\n\`\`\`\n` +
      `\n` +
      `### 🏠 GLOBAL SET PROMPT — "JANE'S KITCHEN"\n` +
      `Sunny morning kitchen.\n` +
      `\n` +
      sonnet46SectionC;
    const r = parseProductionManual(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manual.characterPrompt).toMatch(/30yo woman with dark hair/);
      // The body still contains the short fence verbatim — that's fine.
      // The important thing is the substantive prose survived.
    }
  });
});

describe('Polish-9.18: hasQuotedDialogue', () => {
  it('detects quoted dialogue in clip body', () => {
    expect(hasQuotedDialogue('Static iPhone shot. "Your skin care routine is wrong."')).toBe(true);
  });

  it('detects the master prompt bracket form too (which wraps a quoted line)', () => {
    expect(
      hasQuotedDialogue(
        '[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Click below now."',
      ),
    ).toBe(true);
  });

  it('ignores incidental short quotes (e.g. "ok")', () => {
    expect(hasQuotedDialogue('She says "ok".')).toBe(false);
  });

  it('returns false on b-roll clip body with no quoted dialogue', () => {
    expect(hasQuotedDialogue('Static iPhone shot. Hand pours coffee into mug.')).toBe(false);
  });
});

describe('Polish-9.18: UGC_FRAMING covers amateur-smartphone realism cues', () => {
  const manual = {
    characterPrompt: 'A 30yo woman with dark hair, wearing blue scrubs.',
    setPrompt: 'Sunny morning kitchen.',
  };
  const clip = {
    clipNumber: 1,
    startingFrameImage: 1,
    videoPrompt: 'Hold mug.',
  };

  it('clip 0 framing has amateur + skin pores + handheld cues', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toMatch(/AMATEUR SMARTPHONE SELFIE/);
    expect(out).toMatch(/handheld/i);
    expect(out).toMatch(/pores/i);
    expect(out).toMatch(/NOT smooth, NOT airbrushed/);
    expect(out).toMatch(/NOT cinematic, NOT studio/);
  });

  it('continuation framing carries the same amateur cues', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out).toMatch(/AMATEUR SMARTPHONE SELFIE/);
    expect(out).toMatch(/Real human skin/);
  });
});

describe('Polish-10.5: isSilentKlingModel', () => {
  it('detects v2.5 model id as silent', () => {
    expect(isSilentKlingModel('kwaivgi/kling-v2.5-turbo-pro')).toBe(true);
  });

  it('detects bare "turbo-pro" slug as silent', () => {
    expect(isSilentKlingModel('vendor/turbo-pro')).toBe(true);
  });

  it('detects "turbo_pro" / "turbopro" spelling as silent', () => {
    expect(isSilentKlingModel('vendor/turbo_pro')).toBe(true);
    expect(isSilentKlingModel('vendor/turbopro')).toBe(true);
  });

  it('treats Kling 2.6 as audio-capable', () => {
    expect(isSilentKlingModel('kwaivgi/kling-v2.6')).toBe(false);
  });

  it('treats Kling v3 omni as audio-capable', () => {
    expect(isSilentKlingModel('kwaivgi/kling-v3-omni-video')).toBe(false);
  });

  it('defaults to silent (safe) when env unset / empty', () => {
    expect(isSilentKlingModel('')).toBe(true);
  });
});

describe('Polish-10.5: stripAudioEraArtifacts', () => {
  it('removes [GENERATE NATIVE AUDIO AND LIP-SYNC ...]: "dialogue" brackets', () => {
    const out = stripAudioEraArtifacts(
      'Hold mug. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Morning!" Smile.',
    );
    expect(out).not.toMatch(/GENERATE NATIVE AUDIO/i);
    expect(out).not.toMatch(/"Morning!"/);
    expect(out).toMatch(/Hold mug\..*Smile\./);
  });

  it('removes bare [GENERATE NATIVE AUDIO ...] brackets without dialogue', () => {
    const out = stripAudioEraArtifacts(
      'Action. [GENERATE NATIVE AUDIO: ambient sound] More action.',
    );
    expect(out).not.toMatch(/GENERATE NATIVE AUDIO/i);
    expect(out).toMatch(/More action\./);
  });

  it('converts "says \\"...\\"" idiom into action description', () => {
    const out = stripAudioEraArtifacts('He says "I made $2100" and smiles.');
    expect(out).toMatch(/talks about I made \$2100/);
    expect(out).not.toMatch(/"I made/);
  });

  it('handles "tells", "saying", "exclaims" too', () => {
    expect(stripAudioEraArtifacts('She tells "great deal"')).toMatch(/talks about great deal/);
    expect(stripAudioEraArtifacts('He saying "really fast"')).toMatch(/talks about really fast/);
    expect(stripAudioEraArtifacts('She exclaims "wow!"')).toMatch(/talks about wow!/);
  });

  it('strips remaining stray quote marks around inline text', () => {
    const out = stripAudioEraArtifacts('Hold the "premium" mug.');
    expect(out).toBe('Hold the premium mug.');
  });

  it('collapses whitespace runs left behind by stripping', () => {
    const out = stripAudioEraArtifacts(
      '[GENERATE NATIVE AUDIO: x]   Hold     mug.   [GENERATE NATIVE AUDIO: y]',
    );
    expect(out).toBe('Hold mug.');
  });
});

describe('Polish-10.5: stripTextCaptionsBroll', () => {
  it('drops sentences mentioning captions / subtitles / on-screen text', () => {
    const out = stripTextCaptionsBroll(
      'Sunny kitchen scene. Caption appears at the bottom: "Day 1". Cabinets visible.',
    );
    expect(out).toMatch(/Sunny kitchen scene\./);
    expect(out).toMatch(/Cabinets visible\./);
    expect(out).not.toMatch(/Caption/i);
  });

  it('drops sentences mentioning b-roll / cutaways / product shots', () => {
    const out = stripTextCaptionsBroll(
      'Hold mug. Cutaway to product shot of the bottle. Look forward.',
    );
    expect(out).toMatch(/Hold mug\./);
    expect(out).toMatch(/Look forward\./);
    expect(out).not.toMatch(/Cutaway/i);
    expect(out).not.toMatch(/product shot/i);
  });

  it('drops montage / split-screen / picture-in-picture sentences', () => {
    const out = stripTextCaptionsBroll(
      'Wide kitchen. Split screen comparison appears here. Walk forward.',
    );
    expect(out).not.toMatch(/Split screen/i);
    expect(out).toMatch(/Walk forward\./);
  });

  it('preserves sentences that do not match the patterns', () => {
    expect(stripTextCaptionsBroll('Sunny kitchen scene. Cabinets visible.')).toBe(
      'Sunny kitchen scene. Cabinets visible.',
    );
  });
});

describe('Polish-10.5: buildKlingSubmitPrompt — silent branch', () => {
  const manual = {
    characterPrompt:
      'A 30yo woman with dark hair, wearing a blue t-shirt. Lower-third caption shows her name.',
    setPrompt: 'Sunny kitchen. B-roll cutaway to coffee beans visible occasionally.',
  };
  const clip = {
    clipNumber: 1,
    startingFrameImage: 1,
    videoPrompt:
      '[USE IMAGE 1 AS STARTING FRAME] Hold mug. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "I made $2100." She says "this is amazing" with a smile.',
    dialogue: 'I made $2100.',
  };

  it('prepends the SILENT_UGC_HARD_DIRECTIVE block', () => {
    const out = buildKlingSubmitPrompt(manual, clip, true);
    expect(out.startsWith('PURE RAW UGC SELFIE VIDEO')).toBe(true);
    expect(out).toMatch(/NO captions/);
    expect(out).toMatch(/NO b-roll/);
    expect(out).toMatch(/Continuous unbroken handheld iPhone selfie shot/);
  });

  it('does NOT include SPEECH_PACING (mentions "dialogue" / "speech" → caption bias)', () => {
    const out = buildKlingSubmitPrompt(manual, clip, true);
    expect(out).not.toMatch(/Speech delivery:/);
    expect(out).not.toMatch(/NATURAL CONVERSATIONAL pace/);
  });

  it('scrubs [GENERATE NATIVE AUDIO ...] directives + quoted dialogue from clip body', () => {
    const out = buildKlingSubmitPrompt(manual, clip, true);
    expect(out).not.toMatch(/GENERATE NATIVE AUDIO/i);
    expect(out).not.toMatch(/"I made \$2100"/);
    expect(out).toMatch(/talks about this is amazing/);
  });

  it('scrubs lower-third / b-roll language from character + set prompts', () => {
    const out = buildKlingSubmitPrompt(manual, clip, true);
    // The user-supplied set/character sentences mentioning these
    // patterns must be gone — only the SILENT_UGC_HARD_DIRECTIVE's
    // "NO b-roll / NO cutaways" suppressor language remains.
    expect(out).not.toMatch(/Lower-third caption shows her name/i);
    expect(out).not.toMatch(/B-roll cutaway to coffee beans/i);
    expect(out).not.toMatch(/coffee beans/i);
    expect(out).not.toMatch(/shows her name/i);
    // Other set/character content survives.
    expect(out).toMatch(/Sunny kitchen\./);
    expect(out).toMatch(/30yo woman/);
  });
});

describe('Polish-10.5: buildKlingSubmitPrompt — audio-capable branch', () => {
  const manual = {
    characterPrompt: 'A 30yo woman in a sunny kitchen.',
    setPrompt: 'Sunny kitchen.',
  };
  const clip = {
    clipNumber: 1,
    startingFrameImage: 1,
    videoPrompt: 'Hold mug, smile.',
    dialogue: 'Morning!',
  };

  it('preserves Polish-9.18 behavior: SPEECH_PACING prepended when dialogue present', () => {
    const out = buildKlingSubmitPrompt(manual, clip, false);
    expect(out).toMatch(/Speech delivery: NATURAL CONVERSATIONAL pace/);
    expect(out).toMatch(/Hold mug, smile\./);
  });

  it('appends [GENERATE NATIVE AUDIO ...] when clip body does not already carry one', () => {
    const out = buildKlingSubmitPrompt(manual, clip, false);
    expect(out).toMatch(/GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE/);
    expect(out).toMatch(/"Morning!"/);
  });

  it('does NOT prepend the silent hard directive', () => {
    const out = buildKlingSubmitPrompt(manual, clip, false);
    expect(out).not.toMatch(/PURE RAW UGC SELFIE VIDEO/);
    expect(out).not.toMatch(/ABSOLUTELY NO text on screen/);
  });
});

describe('Polish-10.5: SILENT_UGC_HARD_DIRECTIVE content', () => {
  it('covers text / caption / overlay suppression', () => {
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO captions/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO subtitles/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO graphics/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO title cards/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO lower thirds/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO watermarks/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO logos/);
  });

  it('covers b-roll / cutaway / multi-shot suppression', () => {
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO b-roll/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO cutaways/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO product shots/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO insert shots/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/NO transitions to other subjects/);
  });

  it('locks the camera on the character', () => {
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/Camera stays on the character/);
    expect(SILENT_UGC_HARD_DIRECTIVE).toMatch(/Continuous unbroken handheld iPhone selfie shot/);
  });
});

describe('Polish-11: extractContinuousDialogue', () => {
  const mkClip = (overrides: Partial<{ videoPrompt: string; dialogue: string }>) => ({
    clipNumber: 1,
    startingFrameImage: 1,
    videoPrompt: overrides.videoPrompt ?? 'Body.',
    dialogue: overrides.dialogue,
  });

  it('joins clip.dialogue values in clip order into one TTS-ready string', () => {
    const out = extractContinuousDialogue([
      mkClip({ dialogue: 'Hi there.' }),
      mkClip({ dialogue: 'Today I tried this.' }),
      mkClip({ dialogue: 'Click below.' }),
    ]);
    expect(out).toBe('Hi there. Today I tried this. Click below.');
  });

  it('falls back to [GENERATE NATIVE AUDIO ...]: "..." bracket when clip.dialogue is missing', () => {
    const out = extractContinuousDialogue([
      mkClip({
        videoPrompt:
          'Static iPhone shot. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Morning!" Smile.',
      }),
    ]);
    expect(out).toBe('Morning!');
  });

  it('falls back to any quoted string when neither dialogue nor bracket is present', () => {
    const out = extractContinuousDialogue([
      mkClip({ videoPrompt: 'She holds up "this product".' }),
    ]);
    expect(out).toBe('this product');
  });

  it('skips clips with no extractable dialogue', () => {
    const out = extractContinuousDialogue([
      mkClip({ dialogue: 'Real.' }),
      mkClip({ videoPrompt: 'B-roll only.' }),
      mkClip({ dialogue: 'Done.' }),
    ]);
    expect(out).toBe('Real. Done.');
  });

  it('deduplicates consecutive identical lines (parser + bracket echo)', () => {
    const out = extractContinuousDialogue([
      mkClip({
        videoPrompt: 'Body. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Same thing"',
        dialogue: 'Same thing',
      }),
      mkClip({ dialogue: 'Same thing' }),
      mkClip({ dialogue: 'Different.' }),
    ]);
    expect(out).toBe('Same thing Different.');
  });

  it('returns empty string when no clip carries dialogue', () => {
    expect(extractContinuousDialogue([mkClip({ videoPrompt: 'b-roll only' })])).toBe('');
    expect(extractContinuousDialogue([])).toBe('');
  });

  it('collapses internal whitespace runs', () => {
    const out = extractContinuousDialogue([mkClip({ dialogue: 'Multi  word    spaces.' })]);
    expect(out).toBe('Multi word spaces.');
  });
});

describe('Polish-11.2: IMAGE_UGC_HARD_DIRECTIVE content', () => {
  it('forbids text / captions / overlays / watermarks / logos', () => {
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/ABSOLUTELY NO TEXT/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO captions/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO subtitles/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO title cards/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO lower thirds/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO chyrons/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO text overlays/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO watermarks/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO logos/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO speech bubbles/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO printed text on objects/);
  });

  it('forbids b-roll / insert / picture-in-picture / multi-panel compositions', () => {
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO B-roll inset/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO picture-in-picture/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO multi-panel layout/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO product close-ups composited in/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO money close-ups/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO phone screenshots superimposed/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO insert shots/);
  });

  it('locks the frame to a single character + single environment + photorealistic skin', () => {
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/AMATEUR SMARTPHONE SELFIE PHOTO/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/PHOTOREALISTIC/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/Real human skin texture with pores/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/Single clean clear photograph/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/Nothing else in frame/);
  });
});

describe('Polish-11.2: buildImagePromptForClip scrubs captions / b-roll / audio brackets from inputs', () => {
  const manual = {
    characterPrompt:
      'A 30yo woman with dark hair, wearing a blue cotton t-shirt. Lower-third caption shows her name throughout.',
    setPrompt:
      'Sunny morning kitchen. B-roll cutaway to coffee beans visible occasionally. Product shot of mug.',
  };
  const clip = {
    clipNumber: 1,
    startingFrameImage: 1,
    videoPrompt:
      '[USE IMAGE 1 AS STARTING FRAME] Hold mug. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Morning!" Caption appears at the bottom of the screen.',
    dialogue: 'Morning!',
  };

  it('prepends IMAGE_UGC_HARD_DIRECTIVE before the Polish-9.18 UGC_FRAMING', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out.startsWith('AMATEUR SMARTPHONE SELFIE PHOTO')).toBe(true);
    // UGC_FRAMING follows the hard directive.
    expect(out).toMatch(/Single character, single view, NOT a character sheet/);
  });

  it('strips caption / b-roll / lower-third language from user-supplied content', () => {
    const out = buildImagePromptForClip(manual, clip);
    // None of the source-content phrases survive — only the hard-
    // directive's "NO ..." suppressors remain.
    expect(out).not.toMatch(/Lower-third caption shows her name/);
    expect(out).not.toMatch(/B-roll cutaway to coffee beans/);
    expect(out).not.toMatch(/Product shot of mug/);
    expect(out).not.toMatch(/Caption appears at the bottom/);
  });

  it('strips [GENERATE NATIVE AUDIO ...] and [USE IMAGE X] directives from the clip body', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).not.toMatch(/GENERATE NATIVE AUDIO/);
    expect(out).not.toMatch(/USE IMAGE 1 AS STARTING FRAME/);
    expect(out).not.toMatch(/"Morning!"/);
  });

  it('preserves the surviving description content (character + scene + clip action)', () => {
    const out = buildImagePromptForClip(manual, clip);
    expect(out).toMatch(/30yo woman/);
    expect(out).toMatch(/blue cotton t-shirt/);
    expect(out).toMatch(/Sunny morning kitchen\./);
    expect(out).toMatch(/Hold mug\./);
  });

  it('legacy clip.imagePrompt path still gets IMAGE_UGC_HARD_DIRECTIVE prepended', () => {
    const out = buildImagePromptForClip(
      { characterPrompt: 'C', setPrompt: 'S' },
      {
        clipNumber: 1,
        startingFrameImage: 1,
        videoPrompt: 'V',
        imagePrompt: 'Pre-baked clip image prompt.',
      },
    );
    expect(out.startsWith('AMATEUR SMARTPHONE SELFIE PHOTO')).toBe(true);
    expect(out).toMatch(/Pre-baked clip image prompt\.$/);
  });
});

describe('Polish-11.2: continuationImagePrompt scrubs the same inputs + prepends IMAGE_UGC_HARD_DIRECTIVE', () => {
  const manual = {
    characterPrompt:
      'A 30yo woman with dark hair, wearing a blue cotton t-shirt. Lower-third caption banner shows the brand name.',
    setPrompt: 'Sunny morning kitchen. Cutaway to product shot of coffee mug appears occasionally.',
  };
  const clip = {
    clipNumber: 2,
    startingFrameImage: 2,
    videoPrompt:
      '[USE IMAGE 2 AS STARTING FRAME] Raise mug, smile widens. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Mmm!" Caption at bottom of screen.',
  };

  it('prepends IMAGE_UGC_HARD_DIRECTIVE', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out.startsWith('AMATEUR SMARTPHONE SELFIE PHOTO')).toBe(true);
  });

  it('strips caption / b-roll / lower-third language', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out).not.toMatch(/Lower-third caption banner/);
    expect(out).not.toMatch(/product shot of coffee mug/i);
    expect(out).not.toMatch(/Caption at bottom of screen/);
  });

  it('strips audio-era brackets from the per-clip "Now: …" line', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out).not.toMatch(/GENERATE NATIVE AUDIO/);
    expect(out).not.toMatch(/USE IMAGE 2 AS STARTING FRAME/);
    expect(out).not.toMatch(/"Mmm!"/);
  });

  it('preserves the same-framing / wardrobe-lock continuity language', () => {
    const out = continuationImagePrompt(manual, clip);
    expect(out).toMatch(/Exact same framing as Image 1/);
    expect(out).toMatch(/Wardrobe: EXACTLY as in Image 1/);
    expect(out).toMatch(/blue cotton t-shirt/);
    expect(out).toMatch(/Raise mug, smile widens\./);
  });
});
