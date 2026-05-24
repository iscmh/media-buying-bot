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
  getPromptsBaseDir,
  getSora2DeconstructorSystem,
  getSora2Examples,
  getSora2OptimizerInstructions,
  getUgcIphoneRealismSkill,
  getUniversalUgcMasterPrompt,
} from '../src/prompt-loader';

describe('Polish-6: prompt-loader', () => {
  it('resolves the prompts base directory', () => {
    const dir = getPromptsBaseDir();
    expect(dir).toBeTruthy();
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('loads UNIVERSAL_UGC_MASTER_PROMPT (non-empty)', () => {
    expect(getUniversalUgcMasterPrompt().length).toBeGreaterThan(100);
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

  it('prompt files on disk match the expected count (19 .md files)', () => {
    const dir = getPromptsBaseDir();
    const allFiles: string[] = [];
    function walk(d: string) {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(d, entry.name));
        else if (entry.name.endsWith('.md')) allFiles.push(join(d, entry.name));
      }
    }
    walk(dir);
    expect(allFiles.length).toBe(19);
  });
});
