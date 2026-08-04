import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/api-keys';

/**
 * Polish-25.10 Commit 59 tripwire: the plaintext-in / hash-out
 * contract of the API key generator MUST be stable — the auth
 * middleware hashes an incoming Bearer token and looks up the
 * DB row by that hash, so any regression in the hash function
 * silently locks every user out of the API.
 *
 * The prefix column is the operator's only visual anchor in the
 * /settings/api list ("sk_live_aB3xYz…"), so its length + slot
 * position matters too — an off-by-one turns the whole list
 * into unreadable soup.
 */

describe('generateApiKey', () => {
  it('emits a plaintext token that starts with sk_live_', () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith('sk_live_')).toBe(true);
  });

  it('emits enough entropy that two calls never collide', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { plaintext } = generateApiKey();
      expect(seen.has(plaintext)).toBe(false);
      seen.add(plaintext);
    }
  });

  it('stores SHA-256 (hex) of the FULL plaintext, not the random-only tail', () => {
    const { plaintext, hash } = generateApiKey();
    // If the hash function ever drifts to hashing the tail alone, an
    // auth-time re-hash of the full plaintext would miss the row —
    // and we'd have a silent 401 for every existing key. Pin both
    // sides of the contract:
    expect(hash).toBe(hashApiKey(plaintext));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sets the prefix to the first 8 chars after the sk_live_ marker', () => {
    const { plaintext, prefix } = generateApiKey();
    expect(prefix.length).toBe(8);
    // The prefix must be exactly what the operator will see next to
    // "sk_live_" in the /settings/api list — matching that avoids
    // the "why does my prefix on-screen not match what I copied"
    // support ticket.
    expect(plaintext.startsWith(`sk_live_${prefix}`)).toBe(true);
  });
});

describe('hashApiKey', () => {
  it('is deterministic', () => {
    const raw = 'sk_live_abc123deadbeef';
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
  });

  it('is sensitive to a single-character difference', () => {
    const a = hashApiKey('sk_live_abc123');
    const b = hashApiKey('sk_live_abc124');
    expect(a).not.toBe(b);
  });
});
