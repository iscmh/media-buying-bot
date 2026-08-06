/**
 * Polish-26 Commit 61: HeyGen becomes platform-managed (mirroring
 * the Polish-25.2 Commit 11 MakeUGC pattern).
 *
 * Business model: HeyGen v3 PAYG replaces MakeUGC as the primary
 * managed Instant UGC backend. Operator holds ONE HeyGen API key
 * funded on PAYG; every user's generation draws from that. Users
 * see the feature under the same "Instant UGC" branding.
 *
 * Resolution precedence:
 *   1. env HEYGEN_MANAGED_KEY — the operator-provided platform key
 *      (production + preview environments).
 *   2. loadDecryptedKeys(userId, ['heygen']) — user BYOK fallback.
 *      Keeps dev-mode + operators-testing-with-their-own-key
 *      working when the env var isn't set. Also honors any legacy
 *      per-user HeyGen rows from the Polish-24 BYOK era.
 *
 * NOTE: the legacy heygen-client.ts / generate-ugc-variants.ts
 * (Polish-24 track) continue to use loadDecryptedKeys directly
 * — this resolver is scoped to the new Polish-26 v3 worker only.
 */
import { MissingProviderKeyError, loadDecryptedKeys } from './load-keys';

const ENV_KEY_NAME = 'HEYGEN_MANAGED_KEY';

export interface ResolveHeygenManagedKeyOptions {
  userId: string;
}

export interface ResolveHeygenManagedKeyResult {
  apiKey: string;
  /** Which source the key came from — logged for forensics. */
  source: 'env' | 'byok';
}

export async function resolveHeygenManagedKey(
  opts: ResolveHeygenManagedKeyOptions,
): Promise<ResolveHeygenManagedKeyResult> {
  const envKey = process.env[ENV_KEY_NAME]?.trim();
  if (envKey && envKey.length > 0) {
    return { apiKey: envKey, source: 'env' };
  }
  const decrypted = await loadDecryptedKeys(opts.userId, ['heygen']);
  const byokKey = decrypted.heygen;
  if (byokKey && byokKey.length > 0) {
    return { apiKey: byokKey, source: 'byok' };
  }
  throw new MissingProviderKeyError('heygen');
}
