import { z } from 'zod';

/**
 * Phase 3a tool providers — Gemini Vision (concept analysis), Claude
 * (copy + prompt refinement), Kie.ai (Sora 2 video). Spec puts Kie.ai
 * here even though it's a video provider so the schema split matches
 * the new tool_connections table.
 *
 * Validation is format-only for Phase 3a (regex). Real verification
 * lands in Phase 3b alongside live API calls.
 */

export type ToolProviderName = 'gemini' | 'claude' | 'kie_ai';

const TOOL_KEY_PATTERN = /^[A-Za-z0-9_:.-]{20,512}$/;

export const ToolProviderKeyInputSchema = z
  .object({
    provider: z.enum(['gemini', 'claude', 'kie_ai']),
    apiKey: z.string().trim().min(1, 'Paste your API key.'),
  })
  .superRefine((value, ctx) => {
    if (!TOOL_KEY_PATTERN.test(value.apiKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Keys are 20+ characters of letters, numbers, hyphens, underscores, dots, or colons.',
        path: ['apiKey'],
      });
    }
  });

export type ToolProviderKeyInput = z.infer<typeof ToolProviderKeyInputSchema>;

export const TOOL_PROVIDER_META: Record<
  ToolProviderName,
  {
    label: string;
    role: string;
    description: string;
    apiDocsUrl: string;
    keyHint: string;
  }
> = {
  gemini: {
    label: 'Gemini',
    role: 'Vision + image gen',
    description:
      'Used for concept analysis (UGC vision deconstruction) and static image generation.',
    apiDocsUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    keyHint: 'Generate at aistudio.google.com → "Get API key". Starts with AI...',
  },
  claude: {
    label: 'Claude',
    role: 'Copy + prompt refinement',
    description: 'Used for static ad copy generation and UGC prompt refinement.',
    apiDocsUrl: 'https://docs.anthropic.com/en/api/getting-started',
    keyHint: 'Generate at console.anthropic.com → API Keys. Starts with sk-ant-...',
  },
  kie_ai: {
    label: 'Kie.ai',
    role: 'Video gen (Sora 2)',
    description: 'Recommended primary for UGC video generation.',
    apiDocsUrl: 'https://docs.kie.ai/',
    keyHint: 'Generate at kie.ai → Account → API Keys.',
  },
};

export const TOOL_PROVIDERS_ORDER: ToolProviderName[] = ['gemini', 'claude', 'kie_ai'];
