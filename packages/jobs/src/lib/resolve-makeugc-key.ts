/**
 * Polish-25.2 Commit 11: MakeUGC becomes platform-managed.
 *
 * Business model shift: MakeUGC is no longer BYOK. The operator
 * runs a single MakeUGC API Starter subscription and every user's
 * generation draws from that shared credit pool. Users see the
 * feature under "Instant UGC" branding + never paste a MakeUGC key.
 *
 * Resolution precedence at auth time:
 *   1. env MAKEUGC_MANAGED_KEY — the operator-provided platform key
 *      (production + preview environments).
 *   2. loadDecryptedKeys(userId, ['makeugc']) — user BYOK fallback.
 *      Keeps dev-mode + operators-testing-with-their-own-key working
 *      when the env var isn't set. Also honors any legacy per-user
 *      MakeUGC rows still in ai_provider_connections without forcing
 *      a data migration.
 *
 * Internal names stay unchanged (makeugc_client.ts, table columns,
 * log prefixes, metadata keys like polish25_makeugc_credits_used) so
 * forensics stay readable across the pre-/post-Commit-11 line.
 */
import { MissingProviderKeyError, loadDecryptedKeys } from './load-keys';

const ENV_KEY_NAME = 'MAKEUGC_MANAGED_KEY';

export interface ResolveMakeugcKeyOptions {
  userId: string;
}

export interface ResolveMakeugcKeyResult {
  apiKey: string;
  /** Which source the key came from — logged for forensics. */
  source: 'env' | 'byok';
}

/**
 * Resolve the MakeUGC API key for a given user. Prefers the
 * platform-managed env var; falls back to the user's BYOK row.
 *
 * Throws MissingProviderKeyError('makeugc') when neither source
 * is available — the worker's existing MissingProviderKeyError
 * handler surfaces a clean "reconnect" message to the user, though
 * post-Commit-11 that path is only reachable in dev environments
 * where MAKEUGC_MANAGED_KEY hasn't been set + the user hasn't
 * connected their own key.
 */
export async function resolveMakeugcKey(
  opts: ResolveMakeugcKeyOptions,
): Promise<ResolveMakeugcKeyResult> {
  const envKey = process.env[ENV_KEY_NAME]?.trim();
  if (envKey && envKey.length > 0) {
    return { apiKey: envKey, source: 'env' };
  }
  const decrypted = await loadDecryptedKeys(opts.userId, ['makeugc']);
  const byokKey = decrypted.makeugc;
  if (byokKey && byokKey.length > 0) {
    return { apiKey: byokKey, source: 'byok' };
  }
  // loadDecryptedKeys already throws MissingProviderKeyError when
  // the row is absent — reaching here means the row existed but the
  // decrypted value was empty. Surface the same error so callers
  // can keep their single MissingProviderKeyError catch branch.
  throw new MissingProviderKeyError('makeugc');
}
