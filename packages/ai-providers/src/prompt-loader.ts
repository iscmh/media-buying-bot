import { PROMPTS } from './generated/prompts-bundle';

/**
 * Polish-6 + Polish-9.5: typed prompt loader.
 *
 * Polish-6 originally read .md files via fs.readFileSync at runtime and
 * relied on Vercel's outputFileTracingIncludes to bundle them with the
 * serverless function. In practice the tracing config never resolved
 * inside the deployed function — every Kling/Sora/Nano-Banana run
 * crashed on cold start with "Could not locate prompts directory".
 *
 * Polish-9.5 switches to build-time bundling. scripts/build-prompts.mjs
 * walks src/prompts/**\/*.md at install time, escapes each file's
 * content into a template literal, and writes src/generated/prompts-
 * bundle.ts exporting a Readonly<Record<string,string>>. The text ships
 * inside the JS bundle, no file-tracing required.
 *
 * The .md sources stay the source of truth. The build script writes
 * them verbatim — byte-for-byte fidelity is enforced by the prompt
 * fidelity rule from Polish-6.
 */

function loadPrompt(relativePath: string): () => string {
  let cached: string | null = null;
  return () => {
    if (cached !== null) return cached;
    const text = PROMPTS[relativePath];
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error(
        `Prompt missing from bundle: ${relativePath}. ` +
          `Run "pnpm --filter @mbb/ai-providers build:prompts" to regenerate.`,
      );
    }
    cached = text;
    return text;
  };
}

// =========================================================================
// Exported prompt getters
// =========================================================================

export const getUniversalUgcMasterPrompt = loadPrompt('master/universal-ugc-master-prompt');

export const getForgeExample = loadPrompt('examples/forge-tallow-balm-dr-marcus');

export const getKling3DeconstructorSystem = loadPrompt(
  'kling/kling-3.0-omni-deconstructor-system-prompt',
);

export const getKling3OfficialGuide = loadPrompt('kling/kling-3.0-omni-official-user-guide');

export const getSora2DeconstructorSystem = loadPrompt(
  'sora/gemini-ugc-deconstructor-gem-system-prompt',
);

export const getSora2OptimizerInstructions = loadPrompt(
  'sora/claude-sora-optimizer-project-instructions',
);

export const getSora2Examples = loadPrompt('sora/sora-2-output-examples-video-1-and-2');

export const getUgcIphoneRealismSkill = loadPrompt(
  'image-generation/ugc-photorealistic-iphone-skill',
);

export const getNanoBananaJsonTemplate = loadPrompt(
  'image-generation/nano-banana-character-cloning-json-template',
);

export const getCharacterReplacePrompt = loadPrompt(
  'image-generation/short-prompts-character-replace-and-action-change',
);

/**
 * Polish-9.5: returns the count of prompts in the bundle. Diagnostic
 * helper that replaces the old getPromptsBaseDir() — the bundle has
 * no on-disk base dir anymore.
 */
export function getPromptsBundleSize(): number {
  return Object.keys(PROMPTS).length;
}
