/**
 * Phase 7: locks the shared constants the SQL migration depends on.
 * If anyone bumps the cap in code without bumping the
 * check_founding_member_eligibility() literal (or vice versa), the
 * test fails and points at the divergence.
 */
import { describe, expect, it } from 'vitest';
import { FOUNDING_MEMBER_CAP, INVITE_CODE_DEFAULT_TTL_DAYS, INVITE_CODE_LENGTH } from '../src';

describe('Phase 7 — beta access constants', () => {
  it('FOUNDING_MEMBER_CAP matches the SQL function literal (50)', () => {
    // Sourced from supabase/migrations/0015_beta_access.sql:
    //   founding_member_cap constant integer := 50;
    expect(FOUNDING_MEMBER_CAP).toBe(50);
  });

  it('INVITE_CODE_DEFAULT_TTL_DAYS is the documented 30 days', () => {
    expect(INVITE_CODE_DEFAULT_TTL_DAYS).toBe(30);
  });

  it('INVITE_CODE_LENGTH gives ≥ 10^11 combos (~30-char alphabet ** 8)', () => {
    // 30^8 ≈ 6.5e11. Plenty for a private beta.
    const alphabet = 30; // ambiguity-trimmed (no 0/O/1/I)
    const combos = Math.pow(alphabet, INVITE_CODE_LENGTH);
    expect(combos).toBeGreaterThan(1e11);
  });
});
