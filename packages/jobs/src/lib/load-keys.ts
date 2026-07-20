import { and, eq, isNull } from 'drizzle-orm';
import { decryptSecret, getDb, schema } from '@mbb/db';
import type { ToolProviderName } from '@mbb/shared';

/**
 * Phase 3b: decrypt the user's BYOK keys for the providers a job needs.
 *
 * Returns plaintext keys held in a flat object — the CALLER must use them
 * within a single Inngest step.run and discard the reference. Don't pass
 * the returned object across step boundaries (Inngest serializes step I/O
 * to durable storage; that would persist plaintext keys).
 */
export interface DecryptedKeys {
  gemini?: string;
  claude?: string;
  kie_ai?: string;
  heygen?: string;
  arcads?: string;
  creatify?: string;
  // Polish-20 Commit 4: `kling` retained as a slot only because the
  // Replicate shared helpers (concat / lipsync / audio-trim / frame-
  // extract) tag their BYOK lookups with it — the video-variant
  // worker's stitch step reads this slot to find the Replicate key.
  kling?: string;
  // Polish-6: OpenAI key (Whisper transcription + Sora 2 generation).
  openai?: string;
  // Polish-21: Hedra Character 3 BYOK. Lives in
  // ai_provider_connections under provider='hedra'.
  hedra?: string;
  // Polish-21.0.4 hotfix: ElevenLabs TTS BYOK. Worker generates
  // audio via ElevenLabs and hands the mp3 to Hedra as an
  // audio_id asset. Lives in ai_provider_connections under
  // provider='elevenlabs'. The pg enum always carried this value
  // (Polish-20 Commit 4 only removed the application-level union).
  elevenlabs?: string;
  // Polish-23 Commit 3: WaveSpeedAI BYOK (Higgsfield Soul host).
  // Lives in ai_provider_connections under provider='wavespeed_ai'.
  wavespeed_ai?: string;
  // Polish-25 Commit 2: MakeUGC pre-cast avatar renderer BYOK.
  // Lives in ai_provider_connections under provider='makeugc'.
  makeugc?: string;
}

export type ProviderKey = keyof DecryptedKeys;

export class MissingProviderKeyError extends Error {
  constructor(public readonly provider: ProviderKey) {
    super(`Missing or revoked ${provider} API key. Reconnect from /connections.`);
    this.name = 'MissingProviderKeyError';
  }
}

/**
 * Decrypt the listed tools/providers for `userId`. Throws
 * `MissingProviderKeyError(provider)` for the first one that's missing
 * — caller's job marker handles the failure cleanly.
 */
export async function loadDecryptedKeys(
  userId: string,
  required: ProviderKey[],
): Promise<DecryptedKeys> {
  const db = getDb();
  const out: DecryptedKeys = {};

  for (const provider of required) {
    const ciphertext = await fetchCiphertext(userId, provider);
    if (!ciphertext) {
      throw new MissingProviderKeyError(provider);
    }
    out[provider] = await decryptSecret(ciphertext);
    void db; // keep tsc happy in unused-locals strict mode
  }

  return out;
}

async function fetchCiphertext(userId: string, provider: ProviderKey): Promise<string | null> {
  const db = getDb();
  // Tool providers (gemini/claude/kie_ai) live in tool_connections;
  // legacy AI providers (heygen/arcads/creatify) live in ai_provider_connections.
  if (provider === 'gemini' || provider === 'claude' || provider === 'kie_ai') {
    const row = await db.query.toolConnections.findFirst({
      where: and(
        eq(schema.toolConnections.userId, userId),
        eq(schema.toolConnections.provider, provider as ToolProviderName),
        eq(schema.toolConnections.status, 'active'),
        isNull(schema.toolConnections.deletedAt),
      ),
      columns: { apiKeyEncrypted: true },
    });
    return row?.apiKeyEncrypted ?? null;
  }

  // heygen / arcads / creatify / kling / openai all live in
  // ai_provider_connections.
  //
  // Polish-9.3: when the worker asks for 'kling' the user might have
  // connected the key under the Polish-8 'Replicate' UI card, which
  // writes provider='replicate' on the DB row (Replicate is the API
  // host for Kling 3.0). Fall back to that row so the worker actually
  // finds the key instead of throwing MissingProviderKeyError.
  type AiProviderEnum = typeof schema.aiProviderConnections.provider extends {
    _: { data: infer D };
  }
    ? D
    : string;
  const lookups = (
    provider === 'kling' ? (['kling', 'replicate'] as const) : ([provider] as const)
  ) as readonly AiProviderEnum[];
  for (const p of lookups) {
    const row = await db.query.aiProviderConnections.findFirst({
      where: and(
        eq(schema.aiProviderConnections.userId, userId),
        eq(schema.aiProviderConnections.provider, p),
        eq(schema.aiProviderConnections.status, 'active'),
        isNull(schema.aiProviderConnections.deletedAt),
      ),
      columns: { apiKeyEncrypted: true },
    });
    if (row?.apiKeyEncrypted) return row.apiKeyEncrypted;
  }
  return null;
}
