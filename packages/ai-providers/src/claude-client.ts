import { computeClaudeCost } from '@mbb/shared';
import { callProvider } from './chokepoint';

/**
 * Anthropic Claude messages client (Sonnet 4).
 *
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Auth: `x-api-key` header. Also requires `anthropic-version: 2023-06-01`.
 *
 * Phase 3b uses fetch directly. Model pinned to `claude-sonnet-4-20250514`
 * per spec; bump in actual-cost.ts pricing snapshot if rotated.
 */

const CLAUDE_BASE = 'https://api.anthropic.com/v1';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const CLAUDE_TIMEOUT_MS = 30_000;

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
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: input.maxTokens ?? 4096,
    system: input.systemPrompt,
    messages: [{ role: 'user' as const, content: input.userMessage }],
  };

  const result = await callProvider<ClaudeResponse>({
    userId: input.userId,
    provider: 'claude',
    url,
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    requestBodyForLog: {
      model: CLAUDE_MODEL,
      max_tokens: body.max_tokens,
      system_prompt_chars: input.systemPrompt.length,
      user_message_chars: input.userMessage.length,
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
      model: CLAUDE_MODEL,
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
