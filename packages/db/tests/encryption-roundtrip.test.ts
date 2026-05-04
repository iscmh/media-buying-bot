/**
 * Vault + pgcrypto roundtrip: encrypt(plain) → store → decrypt(stored) === plain.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at a Postgres with our migrations applied
 *   - vault.secrets row with name=SUPABASE_VAULT_KEY_ID (mbb_master_key_v1)
 *
 * Skip-if-unavailable so CI stays green until the test DB is wired up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, decryptSecret, encryptSecret } from '../src';

const skip = !process.env.TEST_DATABASE_URL;

describe.skipIf(skip)('Vault encryption roundtrip', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL && process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it('roundtrips an ASCII access token', async () => {
    const original = 'EAAxxxxxxx_short_test_token_12345';
    const ciphertext = await encryptSecret(original);
    expect(ciphertext).not.toContain(original);
    expect(ciphertext.length).toBeGreaterThan(original.length);
    const decrypted = await decryptSecret(ciphertext);
    expect(decrypted).toBe(original);
  });

  it('produces different ciphertext on each encryption (semantic)', async () => {
    const plain = 'EAA-nonce-test-123';
    const a = await encryptSecret(plain);
    const b = await encryptSecret(plain);
    // pgp_sym_encrypt uses a random session key per call, so identical plaintext
    // produces distinct ciphertext. Both decrypt to the same plaintext.
    expect(a).not.toBe(b);
    expect(await decryptSecret(a)).toBe(plain);
    expect(await decryptSecret(b)).toBe(plain);
  });

  it('refuses to encrypt the empty string (defense against accidental wipe)', async () => {
    await expect(encryptSecret('')).rejects.toThrow();
  });

  it('rejects malformed ciphertext on decrypt', async () => {
    await expect(decryptSecret('not-valid-armored-pgp-bytes')).rejects.toThrow();
  });
});
