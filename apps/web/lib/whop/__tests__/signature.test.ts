/**
 * Phase 8: Whop webhook signature verification. Pure function — no DB,
 * no fetch. Locks the contract:
 *   - missing header → reject
 *   - missing secret → reject
 *   - tampered body → reject
 *   - valid HMAC-SHA256 of the raw body → accept (raw + 'sha256=' prefix)
 *   - timing-safe (we test "almost-correct" sigs reject)
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyWhopSignature } from '../signature';

const ORIGINAL_ENV = process.env;
const SECRET = 'unit-test-secret-1';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('verifyWhopSignature', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, WHOP_WEBHOOK_SECRET: SECRET };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('accepts a correctly-signed body (raw hex)', () => {
    const body = JSON.stringify({ id: 'evt_1', event: 'membership.went_valid' });
    expect(verifyWhopSignature(body, sign(body))).toBe(true);
  });

  it('accepts a sha256= prefix on the header (provider varies)', () => {
    const body = '{}';
    expect(verifyWhopSignature(body, `sha256=${sign(body)}`)).toBe(true);
  });

  it('rejects when the header is missing', () => {
    expect(verifyWhopSignature('{}', null)).toBe(false);
  });

  it('rejects when the secret is unset (dev-mode kill switch)', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.WHOP_WEBHOOK_SECRET;
    const body = '{}';
    const sig = createHmac('sha256', 'anything').update(body).digest('hex');
    expect(verifyWhopSignature(body, sig)).toBe(false);
  });

  it('rejects when the body has been tampered with', () => {
    const original = JSON.stringify({ id: 'evt_1' });
    const sig = sign(original);
    const tampered = JSON.stringify({ id: 'evt_1_tampered' });
    expect(verifyWhopSignature(tampered, sig)).toBe(false);
  });

  it('rejects a length-mismatched signature without throwing', () => {
    expect(verifyWhopSignature('{}', 'abcdef')).toBe(false);
  });

  it('rejects junk that is not hex', () => {
    expect(verifyWhopSignature('{}', 'g'.repeat(64))).toBe(false);
  });

  it('is case-insensitive on the hex digest', () => {
    const body = '{}';
    expect(verifyWhopSignature(body, sign(body).toUpperCase())).toBe(true);
  });
});
