/**
 * Polish-29.0.2 Commit 111: pure product-id resolver tests.
 * The grant functions themselves hit `@mbb/db` and are covered by
 * integration + smoke tests; here we lock down the env-mapping and
 * top-up-pack lookup that gate every credit grant.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_TOPUP_PACKS } from '@mbb/shared';
import { isProSubscriptionProduct, resolveTopupPackForProductId } from '../credit-grants';

const ORIGINAL_ENV = process.env;

describe('resolveTopupPackForProductId', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      WHOP_PRODUCT_ID_TOPUP_500: 'prod_topup500_abc',
      WHOP_PRODUCT_ID_TOPUP_2500: 'prod_topup2500_def',
      WHOP_PRODUCT_ID_TOPUP_10000: 'prod_topup10000_ghi',
    };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('maps the 500-credit product id to its pack', () => {
    const pack = resolveTopupPackForProductId('prod_topup500_abc');
    expect(pack).not.toBeNull();
    expect(pack?.sku).toBe('credits-500');
    expect(pack?.credits).toBe(500);
    expect(pack?.bonusCredits).toBe(0);
  });

  it('maps the 2500-credit product id to its pack', () => {
    const pack = resolveTopupPackForProductId('prod_topup2500_def');
    expect(pack?.sku).toBe('credits-2500');
    expect(pack?.credits).toBe(2500);
    expect(pack?.bonusCredits).toBe(0);
  });

  it('maps the 10000-credit product id and preserves the bonus amount', () => {
    const pack = resolveTopupPackForProductId('prod_topup10000_ghi');
    expect(pack?.sku).toBe('credits-10000');
    expect(pack?.credits).toBe(10000);
    expect(pack?.bonusCredits).toBe(2500);
  });

  it('returns null for an unknown product id', () => {
    expect(resolveTopupPackForProductId('prod_random_xyz')).toBeNull();
  });

  it('returns null when the env is not configured', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env['WHOP_PRODUCT_ID_TOPUP_500'];
    delete process.env['WHOP_PRODUCT_ID_TOPUP_2500'];
    delete process.env['WHOP_PRODUCT_ID_TOPUP_10000'];
    expect(resolveTopupPackForProductId('prod_topup500_abc')).toBeNull();
  });

  it('every catalog pack sku is representable in the env mapping', () => {
    // Regression pin: if credit-pricing.ts adds a new pack sku, the
    // resolver above must gain a corresponding env-var branch OR this
    // test needs to be updated to reflect the intentional gap. The
    // helper's env map keys track this.
    const knownSkus = new Set(['credits-500', 'credits-2500', 'credits-10000']);
    for (const pack of CREDIT_TOPUP_PACKS) {
      expect(knownSkus.has(pack.sku)).toBe(true);
    }
  });
});

describe('isProSubscriptionProduct', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      WHOP_PRODUCT_ID_MONTHLY: 'prod_monthly',
      WHOP_PRODUCT_ID_ANNUAL: 'prod_annual',
      WHOP_PRODUCT_ID_LIFETIME: 'prod_lifetime',
    };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('recognizes monthly / annual / lifetime PRO products', () => {
    expect(isProSubscriptionProduct('prod_monthly')).toBe(true);
    expect(isProSubscriptionProduct('prod_annual')).toBe(true);
    expect(isProSubscriptionProduct('prod_lifetime')).toBe(true);
  });

  it('rejects unrelated product ids and unset env values', () => {
    expect(isProSubscriptionProduct('prod_topup2500_def')).toBe(false);
    expect(isProSubscriptionProduct('')).toBe(false);
    process.env = { ...ORIGINAL_ENV };
    delete process.env['WHOP_PRODUCT_ID_MONTHLY'];
    delete process.env['WHOP_PRODUCT_ID_ANNUAL'];
    delete process.env['WHOP_PRODUCT_ID_LIFETIME'];
    // Bare string equality against undefined must NOT match.
    expect(isProSubscriptionProduct('undefined')).toBe(false);
    expect(isProSubscriptionProduct('prod_monthly')).toBe(false);
  });
});
