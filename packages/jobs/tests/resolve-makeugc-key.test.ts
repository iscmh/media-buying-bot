/**
 * Polish-25.2 Commit 11 regression pins — MakeUGC key resolver.
 *
 * MakeUGC transitioned from BYOK to platform-managed: users no
 * longer paste a MakeUGC API key, and the workers read the shared
 * operator-provided key from MAKEUGC_MANAGED_KEY env instead. The
 * resolver keeps a BYOK fallback path so dev environments +
 * operators-testing-with-their-own-key + legacy per-user rows
 * still work without an env var.
 *
 * Precedence: env → BYOK → throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  decryptSecret: vi.fn(async (ciphertext: string) => `decrypted:${ciphertext}`),
  getDb: vi.fn(),
  schema: {
    aiProviderConnections: {},
    toolConnections: {},
  },
}));

// Import AFTER vi.mock so the module picks up the mocked @mbb/db.
import { MissingProviderKeyError } from '../src/lib/load-keys';
import { resolveMakeugcKey } from '../src/lib/resolve-makeugc-key';
import { getDb } from '@mbb/db';

const ENV_KEY = 'MAKEUGC_MANAGED_KEY';
const originalEnv = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
  vi.mocked(getDb).mockReset();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  vi.restoreAllMocks();
});

describe('Polish-25.2 Commit 11: resolveMakeugcKey — env-first precedence', () => {
  it('returns the env-provided key when MAKEUGC_MANAGED_KEY is set', async () => {
    process.env[ENV_KEY] = 'sk-operator-shared-key-value';
    // getDb should NOT be called on the env path — no BYOK query needed.
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('getDb must not be called on the env path');
    });
    const result = await resolveMakeugcKey({ userId: 'user-uuid-abc' });
    expect(result.apiKey).toBe('sk-operator-shared-key-value');
    expect(result.source).toBe('env');
  });

  it('trims whitespace on the env value + treats empty/whitespace as absent', async () => {
    // Empty string should fall through to BYOK.
    process.env[ENV_KEY] = '';
    // Set up a BYOK path so we can prove fallback fired.
    vi.mocked(getDb).mockReturnValue({
      query: {
        aiProviderConnections: {
          findFirst: vi.fn().mockResolvedValue({ apiKeyEncrypted: 'ciphertext-byok-fallback' }),
        },
      },
    } as unknown as ReturnType<typeof getDb>);
    const result = await resolveMakeugcKey({ userId: 'user-uuid' });
    expect(result.source).toBe('byok');
    expect(result.apiKey).toBe('decrypted:ciphertext-byok-fallback');
  });

  it('falls back to user BYOK when env is unset', async () => {
    vi.mocked(getDb).mockReturnValue({
      query: {
        aiProviderConnections: {
          findFirst: vi.fn().mockResolvedValue({ apiKeyEncrypted: 'ciphertext-user-key' }),
        },
      },
    } as unknown as ReturnType<typeof getDb>);
    const result = await resolveMakeugcKey({ userId: 'user-uuid' });
    expect(result.source).toBe('byok');
    expect(result.apiKey).toBe('decrypted:ciphertext-user-key');
  });

  it('throws MissingProviderKeyError when neither env nor BYOK resolves', async () => {
    vi.mocked(getDb).mockReturnValue({
      query: {
        aiProviderConnections: {
          // Row absent — loadDecryptedKeys throws its own MissingProviderKeyError.
          findFirst: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof getDb>);
    await expect(resolveMakeugcKey({ userId: 'user-uuid' })).rejects.toBeInstanceOf(
      MissingProviderKeyError,
    );
  });
});
