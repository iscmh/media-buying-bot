import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from './client';
import { apiKeys } from './schema/api-keys';

/**
 * Polish-25.10 Commit 59: API-key generate / hash / verify / list /
 * revoke helpers.
 *
 * Wire format:  `sk_live_<44-base64url-chars>`   (32 random bytes)
 * Storage:      SHA-256 of the FULL wire string, hex-encoded.
 * Prefix column: first 8 chars AFTER the `sk_live_` marker, for
 *                identification in the /settings/api list ("sk_live_
 *                aB3xYz..." vs. "sk_live_qR9nMk...").
 *
 * Plaintext is returned to the caller EXACTLY ONCE at create time.
 * The DB stores only the hash, so a DB dump can't be replayed as an
 * auth token. Prefix is safe to display because it's not enough to
 * brute-force the remaining entropy (36 base64url chars = 216 bits).
 */

const KEY_MARKER = 'sk_live_';

export interface GeneratedApiKey {
  /** The FULL plaintext wire token. Returned once, never persisted. */
  plaintext: string;
  /** SHA-256 hex of the plaintext. What we store in DB. */
  hash: string;
  /** First 8 chars after the marker — safe to display in the UI. */
  prefix: string;
}

/**
 * Generate a fresh API key. Format matches OpenAI / Anthropic
 * conventions (sk_live_...) which most media buyers already recognize.
 * base64url avoids URL-encoding hazards if a caller accidentally
 * embeds the key in a query string.
 */
export function generateApiKey(): GeneratedApiKey {
  const rand = randomBytes(32).toString('base64url'); // 43-44 chars
  const plaintext = `${KEY_MARKER}${rand}`;
  const hash = hashApiKey(plaintext);
  const prefix = rand.slice(0, 8);
  return { plaintext, hash, prefix };
}

/**
 * Deterministic hash used both at create time (stored in DB) and at
 * auth time (looked up against DB). SHA-256 is fine for high-entropy
 * random tokens — bcrypt/argon2 exists to slow-hash low-entropy
 * passwords; a 256-bit random token has no dictionary to attack.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export interface ApiKeyRow {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function createApiKey(input: {
  userId: string;
  name: string;
}): Promise<{ row: ApiKeyRow; plaintext: string }> {
  const db = getDb();
  const { plaintext, hash, prefix } = generateApiKey();
  const [inserted] = await db
    .insert(apiKeys)
    .values({
      userId: input.userId,
      name: input.name,
      keyHash: hash,
      keyPrefix: prefix,
    })
    .returning();
  if (!inserted) throw new Error('Failed to insert api_keys row');
  return {
    plaintext,
    row: {
      id: inserted.id,
      userId: inserted.userId,
      name: inserted.name,
      keyPrefix: inserted.keyPrefix,
      createdAt: inserted.createdAt,
      lastUsedAt: inserted.lastUsedAt,
      revokedAt: inserted.revokedAt,
    },
  };
}

export async function listApiKeys(userId: string): Promise<ApiKeyRow[]> {
  const db = getDb();
  const rows = await db.query.apiKeys.findMany({
    where: eq(apiKeys.userId, userId),
    orderBy: [desc(apiKeys.createdAt)],
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    keyPrefix: r.keyPrefix,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  }));
}

/**
 * Soft-revoke. We keep the row so audit rows in api_request_log still
 * point at a real FK; auth just refuses any request whose key's
 * `revoked_at IS NOT NULL`.
 */
export async function revokeApiKey(input: {
  userId: string;
  keyId: string;
}): Promise<{ revoked: boolean }> {
  const db = getDb();
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(apiKeys.id, input.keyId), eq(apiKeys.userId, input.userId), isNull(apiKeys.revokedAt)),
    )
    .returning({ id: apiKeys.id });
  return { revoked: result.length > 0 };
}

/**
 * Auth hot path — hash the presented token, look up by hash, reject
 * if revoked. Returns null on any failure (unknown key, revoked key)
 * so the caller can uniformly 401 without leaking which condition
 * failed.
 */
export async function findActiveApiKeyByPlaintext(
  plaintext: string,
): Promise<{ id: string; userId: string } | null> {
  const hash = hashApiKey(plaintext);
  const db = getDb();
  const row = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, hash),
    columns: { id: true, userId: true, revokedAt: true },
  });
  if (!row || row.revokedAt !== null) return null;
  return { id: row.id, userId: row.userId };
}

/**
 * Best-effort last-used stamp. Called from the auth wrapper; never
 * awaited on the response critical path (fire-and-forget), so a
 * transient failure never fails a request.
 */
export async function stampApiKeyLastUsed(keyId: string): Promise<void> {
  const db = getDb();
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
}
