import { computeClaudeCost } from '@mbb/shared';
import { callProvider } from './chokepoint';

/**
 * Anthropic Claude messages client (Sonnet 4.6).
 *
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Auth: `x-api-key` header. Also requires `anthropic-version: 2023-06-01`.
 *
 * Polish-13: migrated off claude-sonnet-4-20250514, which was retired
 * from the Anthropic API on June 15, 2026. Anthropic's deprecation
 * cadence runs ~12 months, so plan to revisit DEFAULT_CLAUDE_MODEL
 * when 4.6 nears its own retirement window. Bump in actual-cost.ts
 * pricing snapshot if rotated.
 */

const CLAUDE_BASE = 'https://api.anthropic.com/v1';
/**
 * Polish-13: centralized model id so future migrations are a one-line
 * change. Vision-detection.ts and any other Claude call site imports
 * this constant rather than hardcoding a string.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
// Polish-9.6: bumped from 30s to 180s. The Kling pipeline's production-
// manual call asks Claude to write 16 clip prompts at maxTokens=16384,
// which routinely runs 30-90s — the old 30s ceiling fired before the
// response landed. Env override lets ops dial it without a redeploy.
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_API_TIMEOUT_MS) || 180_000;

interface ClaudeResponse {
  content?: Array<{ type: 'text'; text: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface ClaudeMessagesInput {
  userId: string;
  apiKey: string;
  systemPrompt: string;
  userMessage: string;
  /** Defaults to 4096; bump for variant generators that emit big JSON arrays. */
  maxTokens?: number;
  generationJobId?: string;
  /**
   * Polish-28.3.6 Commit 91: opt-in prompt caching for large static
   * system-prompt blocks (e.g. the ~100K-token PSYWAR corpus). When
   * `cacheSystemPrompt: true`, we send the system prompt as a
   * structured array with a `cache_control: { type: 'ephemeral' }`
   * marker on it, which tells Anthropic to cache it. First call
   * pays full input tokens ($15/M for Opus); subsequent calls
   * within the ~5-min cache TTL pay ~10% ($1.50/M) for the cached
   * portion. Also toggles the `anthropic-beta: prompt-caching-2024-07-31`
   * header. Backwards-compatible: default `undefined` = string mode
   * (old behavior).
   */
  cacheSystemPrompt?: boolean;
}

export interface ClaudeMessagesResult {
  ok: boolean;
  text?: string;
  /** When response is JSON-shaped, parsed shape. Caller's responsibility to validate. */
  json?: unknown;
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Call Claude with a system prompt + single user message. Returns the
 * concatenated text content + parsed JSON if the response is parseable.
 */
export async function callClaude(input: ClaudeMessagesInput): Promise<ClaudeMessagesResult> {
  const url = `${CLAUDE_BASE}/messages`;
  // Polish-28.3.6 Commit 91: when cacheSystemPrompt is on, we swap
  // the string system prompt for a structured array containing one
  // text block with `cache_control: ephemeral`. That's Anthropic's
  // opt-in prompt-caching mechanism — the marked block plus
  // everything above it in the request gets cached for ~5min.
  const body: Record<string, unknown> = {
    model: DEFAULT_CLAUDE_MODEL,
    max_tokens: input.maxTokens ?? 4096,
    system: input.cacheSystemPrompt
      ? [
          {
            type: 'text',
            text: input.systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ]
      : input.systemPrompt,
    messages: [{ role: 'user' as const, content: input.userMessage }],
  };

  const headers: Record<string, string> = {
    'x-api-key': input.apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (input.cacheSystemPrompt) {
    // Prompt caching is GA now but the beta header remains supported
    // and avoids version-mismatch quirks on older API tiers.
    headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
  }

  const result = await callProvider<ClaudeResponse>({
    userId: input.userId,
    provider: 'claude',
    url,
    method: 'POST',
    headers,
    body,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    requestBodyForLog: {
      model: DEFAULT_CLAUDE_MODEL,
      max_tokens: body.max_tokens,
      system_prompt_chars: input.systemPrompt.length,
      user_message_chars: input.userMessage.length,
      cache_system_prompt: input.cacheSystemPrompt ?? false,
    },
    generationJobId: input.generationJobId,
  });

  if (!result.ok) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    };
  }

  const text = extractText(result.data);
  const usage = result.data.usage ?? {};
  const costUsd = computeClaudeCost(usage);

  if (!text) {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      errorMessage: 'Claude returned no text content',
    };
  }

  // Strip ```json fences if Claude wrapped its JSON. Operator prompts ask
  // for raw JSON, but defense-in-depth.
  const stripped = stripJsonFences(text);
  let json: unknown = undefined;
  try {
    json = JSON.parse(stripped);
  } catch {
    // Not JSON — caller may treat text as freeform.
  }

  return { ok: true, text, json, costUsd, latencyMs: result.latencyMs };
}

function extractText(response: ClaudeResponse): string | null {
  const parts = response.content ?? [];
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text);
  }
  return out.length > 0 ? out.join('') : null;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```$/m.exec(trimmed);
  return fenceMatch && fenceMatch[1] ? fenceMatch[1] : trimmed;
}

/** Lightweight verify: 1-token request. Anthropic returns 401 on bad key. */
export async function verifyClaudeKey(
  apiKey: string,
  userId: string,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const result = await callProvider<ClaudeResponse>({
    userId,
    provider: 'claude',
    url: `${CLAUDE_BASE}/messages`,
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: {
      model: DEFAULT_CLAUDE_MODEL,
      max_tokens: 4,
      messages: [{ role: 'user', content: 'pong' }],
    },
    timeoutMs: 10_000,
    requestBodyForLog: { _verify: true },
  });
  return result.ok ? { ok: true } : { ok: false, errorMessage: result.errorMessage };
}

// =========================================================================
// Phase 3g — Claude-based HeyGen avatar ranking.
// =========================================================================

export interface CompactAvatar {
  id: string;
  name: string;
  gender?: string;
}

export interface ClaudeRankAvatarsResult {
  ok: boolean;
  /** Avatar ids ordered best → worst match, filtered to ids present in the input. */
  rankedIds: string[];
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

const RANK_SYSTEM_PROMPT = `You are a casting director for short-form UGC ads. You receive:
  1. A persona analysis JSON describing the actor in the source winning ad.
  2. A list of available avatars with id, name, and (sometimes) gender.

Rank the avatars by how well they match the source persona. Match priority:
  1. Gender match (hardest constraint — wrong gender ruins the variant).
  2. Apparent age range (avatar names often hint at age — "young", "20s", "teen", etc.).
  3. Vibe / style alignment (casual, professional, fitness, etc.).
  4. Setting / context fit (home, office, gym, outdoor).

Output ONLY a JSON array of avatar id strings, best match first. Include EVERY input avatar exactly once. No commentary, no markdown fences.

Example output: ["a_123","a_456","a_789"]`;

/**
 * Phase 3g: ask Claude to rank a (small) list of HeyGen avatars by match
 * quality against a persona description / analysis blob. Returns the
 * IDs filtered to those that exist in the input — Claude occasionally
 * hallucinates an id, which we silently drop.
 *
 * Caller passes the compact avatar list pre-filtered + capped (~60 max)
 * so the prompt stays cheap. One call per generation regardless of
 * variant count — pipeline takes the top N from the returned ranking.
 */
export async function claudeRankAvatars(input: {
  userId: string;
  apiKey: string;
  /** Stringified persona — usually the analysis JSON, or a synthesized blurb. */
  personaDescription: string;
  avatars: CompactAvatar[];
  generationJobId?: string;
}): Promise<ClaudeRankAvatarsResult> {
  if (input.avatars.length === 0) {
    return {
      ok: false,
      rankedIds: [],
      costUsd: 0,
      latencyMs: 0,
      errorMessage: 'No avatars to rank',
    };
  }

  const userMessage = `Source persona:\n${input.personaDescription}\n\nAvailable avatars (${input.avatars.length}):\n${JSON.stringify(input.avatars)}`;

  const claude = await callClaude({
    userId: input.userId,
    apiKey: input.apiKey,
    systemPrompt: RANK_SYSTEM_PROMPT,
    userMessage,
    // Each id ≈ 10-20 tokens; even 60 avatars only needs ~2k.
    maxTokens: 2048,
    generationJobId: input.generationJobId,
  });

  if (!claude.ok) {
    return {
      ok: false,
      rankedIds: [],
      costUsd: claude.costUsd,
      latencyMs: claude.latencyMs,
      errorMessage: claude.errorMessage,
    };
  }

  if (!Array.isArray(claude.json) || claude.json.some((x) => typeof x !== 'string')) {
    return {
      ok: false,
      rankedIds: [],
      costUsd: claude.costUsd,
      latencyMs: claude.latencyMs,
      errorMessage: 'Claude did not return a JSON array of avatar ids',
    };
  }

  // Drop hallucinated ids + de-dup while preserving order.
  const validIds = new Set(input.avatars.map((a) => a.id));
  const seen = new Set<string>();
  const rankedIds: string[] = [];
  for (const id of claude.json as string[]) {
    if (validIds.has(id) && !seen.has(id)) {
      seen.add(id);
      rankedIds.push(id);
    }
  }

  return {
    ok: true,
    rankedIds,
    costUsd: claude.costUsd,
    latencyMs: claude.latencyMs,
  };
}

// =========================================================================
// Polish-4 — cinematic prompt builder (script → Kling prompt).
// =========================================================================

const CINEMATIC_PROMPT_SYSTEM = `You are a cinematic director writing video prompts for Kling 2.5, a text-to-video model. Your job: translate a short UGC ad script into a vivid 60-120 word cinematic prompt that Kling can render as a 5-second 9:16 vertical clip with NO on-screen actor (the voiceover audio carries the script — visuals should illustrate, not narrate).

REQUIREMENTS:
  1. 3-5 concrete scene cuts that visualize the script's emotional beats. NEVER describe a person reading text or "an actor saying X" — the script is voiceover.
  2. Specify camera angles (close-up, wide, low-angle, tracking), lighting mood (warm afternoon, neon dusk, hospital fluorescent, etc.), and locations.
  3. Vertical 9:16 framing language ("vertical composition", "portrait orientation").
  4. Match the script's emotional pacing — frantic script → fast cuts + handheld; calm script → slow push-ins + soft focus.
  5. NO captions, NO text overlays, NO logos, NO people lip-syncing.
  6. 60-120 words total. Concrete and visual; no abstract phrases like "creative" or "engaging".

Output ONLY the prompt as a single block of prose. No commentary, no markdown, no quotes around it.`;

export interface BuildCinematicPromptInput {
  userId: string;
  apiKey: string;
  /** The UGC ad script (will be voiceover). 1-3 sentences typical. */
  script: string;
  generationJobId?: string;
}

export interface BuildCinematicPromptResult {
  ok: boolean;
  /** The cinematic prompt to feed Kling. */
  prompt?: string;
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Polish-4: turn an ad script into a Kling-ready cinematic prompt via
 * Claude. Saved alongside the generated variant on generationMetadata.
 * Worth saving for debug + regeneration; the script ↔ prompt mapping
 * is the most interpretable artifact of the cinematic pipeline.
 *
 * Caller writes both `script` and `cinematicPrompt` into
 * generated_creatives.generationMetadata for forensics.
 */
export async function buildCinematicPromptFromScript(
  input: BuildCinematicPromptInput,
): Promise<BuildCinematicPromptResult> {
  if (!input.script.trim()) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: 0,
      errorMessage: 'Empty script — cannot build cinematic prompt.',
    };
  }

  const claude = await callClaude({
    userId: input.userId,
    apiKey: input.apiKey,
    systemPrompt: CINEMATIC_PROMPT_SYSTEM,
    userMessage: `Script:\n${input.script}`,
    // 120-word output ≈ 200 tokens; cap modestly so a runaway response
    // doesn't blow the cost budget.
    maxTokens: 512,
    generationJobId: input.generationJobId,
  });

  if (!claude.ok || !claude.text) {
    return {
      ok: false,
      costUsd: claude.costUsd,
      latencyMs: claude.latencyMs,
      errorMessage: claude.errorMessage ?? 'Claude returned no cinematic prompt.',
    };
  }

  // Defense-in-depth — the system prompt asks for raw prose, but if Claude
  // wrapped it in quotes/markdown we strip the common shapes.
  const cleaned = claude.text.trim().replace(/^["']|["']$/g, '');
  return {
    ok: true,
    prompt: cleaned,
    costUsd: claude.costUsd,
    latencyMs: claude.latencyMs,
  };
}
