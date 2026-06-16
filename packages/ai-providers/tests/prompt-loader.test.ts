/**
 * Polish-6 item 3: prompt loader. Every constant loads non-empty
 * content from the .md file; file count matches expected list.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCharacterReplacePrompt,
  getForgeExample,
  getKling3DeconstructorSystem,
  getKling3OfficialGuide,
  getNanoBananaJsonTemplate,
  getPromptsBundleSize,
  getSora2DeconstructorSystem,
  getSora2Examples,
  getSora2OptimizerInstructions,
  getUgcIphoneRealismSkill,
  getUniversalUgcMasterPrompt,
} from '../src/prompt-loader';

describe('Polish-6: prompt-loader', () => {
  it('Polish-9.5: bundle size matches expected prompt count (19)', () => {
    expect(getPromptsBundleSize()).toBe(19);
  });

  it('loads UNIVERSAL_UGC_MASTER_PROMPT (non-empty)', () => {
    expect(getUniversalUgcMasterPrompt().length).toBeGreaterThan(100);
  });

  it('Polish-12.3: UNIVERSAL_UGC_MASTER_PROMPT contains the anti-celebrity restrictions block', () => {
    const text = getUniversalUgcMasterPrompt();
    expect(text).toContain('CRITICAL CONTENT RESTRICTIONS');
    expect(text).toMatch(/real public figure/i);
    expect(text).toMatch(/celebrity/i);
    expect(text).toMatch(/Gemini/);
    // Sanity: DO / DO NOT sections both present.
    expect(text).toMatch(/DO NOT:/);
    expect(text).toMatch(/\nDO:/);
    // The restrictions sit BEFORE the existing "Crucial Hyper-Realism"
    // block — earlier instructions weight higher with Claude.
    const restrictionsIdx = text.indexOf('CRITICAL CONTENT RESTRICTIONS');
    const realismIdx = text.indexOf('Crucial Hyper-Realism');
    expect(restrictionsIdx).toBeGreaterThan(-1);
    expect(realismIdx).toBeGreaterThan(restrictionsIdx);
  });

  it('loads FORGE_EXAMPLE (non-empty)', () => {
    expect(getForgeExample().length).toBeGreaterThan(100);
  });

  it('loads KLING_3_DECONSTRUCTOR_SYSTEM (non-empty)', () => {
    expect(getKling3DeconstructorSystem().length).toBeGreaterThan(100);
  });

  it('loads KLING_3_OFFICIAL_GUIDE (non-empty)', () => {
    expect(getKling3OfficialGuide().length).toBeGreaterThan(100);
  });

  it('loads SORA_2_DECONSTRUCTOR_SYSTEM (non-empty)', () => {
    expect(getSora2DeconstructorSystem().length).toBeGreaterThan(100);
  });

  it('loads SORA_2_OPTIMIZER_INSTRUCTIONS (non-empty)', () => {
    expect(getSora2OptimizerInstructions().length).toBeGreaterThan(100);
  });

  it('loads SORA_2_EXAMPLES (non-empty)', () => {
    expect(getSora2Examples().length).toBeGreaterThan(100);
  });

  it('loads UGC_IPHONE_REALISM_SKILL (non-empty)', () => {
    expect(getUgcIphoneRealismSkill().length).toBeGreaterThan(100);
  });

  it('loads NANO_BANANA_JSON_TEMPLATE (non-empty)', () => {
    expect(getNanoBananaJsonTemplate().length).toBeGreaterThan(100);
  });

  it('loads CHARACTER_REPLACE_PROMPT (non-empty)', () => {
    expect(getCharacterReplacePrompt().length).toBeGreaterThan(100);
  });

  it('on-disk prompt sources still match bundle count (smoke check)', () => {
    // Polish-9.5: belt-and-suspenders — verify the bundle didn't drift
    // from the .md source tree. If a new prompt was added without
    // regenerating the bundle, this fires.
    const dir = join(process.cwd(), 'src', 'prompts');
    if (!statSync(dir, { throwIfNoEntry: false })) return;
    const allFiles: string[] = [];
    function walk(d: string) {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(d, entry.name));
        else if (entry.name.endsWith('.md')) allFiles.push(join(d, entry.name));
      }
    }
    walk(dir);
    expect(allFiles.length).toBe(getPromptsBundleSize());
  });
});
