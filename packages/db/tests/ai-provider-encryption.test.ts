/**
 * AI provider key roundtrip via the same encryptSecret/decryptSecret used
 * for Meta tokens. The encryption-roundtrip.test.ts already covers the
 * generic helper; this test verifies the specific case of provider keys
 * with their characteristic shapes (Creatify ID:KEY, Arcads with colons,
 * HeyGen with special chars).
 *
 * Skip-if-unavailable.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, decryptSecret, encryptSecret } from '../src';

const skip = !process.env.TEST_DATABASE_URL;

describe.skipIf(skip)('AI provider key encryption roundtrip', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('roundtrips a HeyGen-shaped key', async () => {
    const original = 'NjBhNTI3OWQ1ZmYzNDY1YjlhNGMxMjMyMzY3ODkwYWI=';
    const ciphertext = await encryptSecret(original);
    expect(ciphertext).not.toContain(original);
    expect(await decryptSecret(ciphertext)).toBe(original);
  });

  it('roundtrips a Creatify combined ID:KEY', async () => {
    const original = 'abc-12345:def_67890_-_creatify_secret_xyz_long';
    const ciphertext = await encryptSecret(original);
    expect(await decryptSecret(ciphertext)).toBe(original);
  });

  it('roundtrips an Arcads-style key with colons and dashes', async () => {
    const original = 'client_abc-123:secret_def-456-789-xyz-012';
    const ciphertext = await encryptSecret(original);
    expect(await decryptSecret(ciphertext)).toBe(original);
  });
});
