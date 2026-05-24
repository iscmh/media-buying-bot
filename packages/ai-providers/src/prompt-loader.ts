import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Polish-6 item 3: typed prompt loader. Lazy-reads .md files from
 * src/prompts/ at first access via fs.readFileSync. Content is cached
 * in module-level closures — subsequent calls return the cached string
 * with zero I/O.
 *
 * WHY fs.readFileSync instead of inlining the text as a TS string:
 *   - The user's prompt files are field-tested at scale. Inlining them
 *     invites accidental reformatting by linters, editors, or difftools.
 *   - The .md files are the source of truth; code READS them, never
 *     owns them.
 *
 * Vercel compatibility: the prompts dir must be bundled into the
 * serverless function output. next.config needs:
 *   experimental: { outputFileTracingIncludes: {
 *     '/api/inngest': ['./node_modules/@mbb/ai-providers/src/prompts/**']
 *   }}
 * The resolvePromptsDir() helper tries multiple base paths so the
 * loader works in dev (workspace source), production (bundled), and
 * vitest (cwd-relative).
 */

let _promptsDir: string | null = null;

function resolvePromptsDir(): string {
  if (_promptsDir) return _promptsDir;

  // ESM: __dirname equivalent
  const thisDir =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

  const candidates = [
    join(thisDir, '..', 'prompts'),
    join(thisDir, 'prompts'),
    join(process.cwd(), 'packages', 'ai-providers', 'src', 'prompts'),
    join(process.cwd(), 'node_modules', '@mbb', 'ai-providers', 'src', 'prompts'),
  ];

  for (const dir of candidates) {
    try {
      readFileSync(join(dir, 'master', 'universal-ugc-master-prompt.md'), 'utf-8');
      _promptsDir = dir;
      return dir;
    } catch {
      // try next
    }
  }

  throw new Error(
    `Could not locate prompts directory. Tried:\n${candidates.join('\n')}\n` +
      'Ensure the prompts/ folder is included in the Vercel function bundle ' +
      'via outputFileTracingIncludes.',
  );
}

function lazyLoad(relativePath: string): () => string {
  let cached: string | null = null;
  return () => {
    if (cached !== null) return cached;
    const dir = resolvePromptsDir();
    cached = readFileSync(join(dir, relativePath), 'utf-8');
    return cached;
  };
}

// =========================================================================
// Exported prompt getters
// =========================================================================

export const getUniversalUgcMasterPrompt = lazyLoad('master/universal-ugc-master-prompt.md');

export const getForgeExample = lazyLoad('examples/forge-tallow-balm-dr-marcus.md');

export const getKling3DeconstructorSystem = lazyLoad(
  'kling/kling-3.0-omni-deconstructor-system-prompt.md',
);

export const getKling3OfficialGuide = lazyLoad('kling/kling-3.0-omni-official-user-guide.md');

export const getSora2DeconstructorSystem = lazyLoad(
  'sora/gemini-ugc-deconstructor-gem-system-prompt.md',
);

export const getSora2OptimizerInstructions = lazyLoad(
  'sora/claude-sora-optimizer-project-instructions.md',
);

export const getSora2Examples = lazyLoad('sora/sora-2-output-examples-video-1-and-2.md');

export const getUgcIphoneRealismSkill = lazyLoad(
  'image-generation/ugc-photorealistic-iphone-skill.md',
);

export const getNanoBananaJsonTemplate = lazyLoad(
  'image-generation/nano-banana-character-cloning-json-template.md',
);

export const getCharacterReplacePrompt = lazyLoad(
  'image-generation/short-prompts-character-replace-and-action-change.md',
);

/**
 * For diagnostics: returns the resolved base directory the loader
 * found. Useful in health-check endpoints.
 */
export function getPromptsBaseDir(): string {
  return resolvePromptsDir();
}
