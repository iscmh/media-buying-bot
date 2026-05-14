/**
 * Phase 8: parseMembership + productIdToPlanTier + isAddOnAdAccountProduct.
 * Pure helpers — no network, no DB. They're the bridge between Whop's
 * payload shape and our subscriptions/entitlements columns; locking
 * them down means a future Whop API tweak surfaces as a test failure
 * rather than silently writing bad rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAddOnAdAccountProduct, parseMembership, productIdToPlanTier } from '../client';

const ORIGINAL_ENV = process.env;

describe('parseMembership', () => {
  it('normalizes a typical valid-membership webhook payload', () => {
    const raw = {
      id: 'mem_123',
      status: 'active',
      product_id: 'prod_monthly_abc',
      user: { id: 'user_w_42', email: 'OPS@Example.com' },
      current_period_start: '2026-05-01T00:00:00Z',
      current_period_end: '2026-06-01T00:00:00Z',
      cancel_at_period_end: false,
      metadata: { application_id: 'app_1' },
    };
    const m = parseMembership(raw);
    expect(m.id).toBe('mem_123');
    expect(m.status).toBe('active');
    expect(m.productId).toBe('prod_monthly_abc');
    expect(m.email).toBe('OPS@Example.com'); // case preserved — caller lowercases
    expect(m.whopUserId).toBe('user_w_42');
    expect(m.currentPeriodStart?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(m.cancelAtPeriodEnd).toBe(false);
    expect(m.metadata.application_id).toBe('app_1');
  });

  it('supports the older nested product.id shape', () => {
    const m = parseMembership({
      id: 'mem_x',
      status: 'active',
      product: { id: 'prod_nested' },
    });
    expect(m.productId).toBe('prod_nested');
  });

  it('maps unknown status strings to expired (safer default)', () => {
    expect(parseMembership({ id: 'm', status: 'something_new' }).status).toBe('expired');
  });

  it('maps cancelled (UK spelling) to canceled', () => {
    expect(parseMembership({ id: 'm', status: 'cancelled' }).status).toBe('canceled');
  });

  it('treats trialing memberships as active (they retain access)', () => {
    expect(parseMembership({ id: 'm', status: 'trialing' }).status).toBe('active');
  });

  it('handles epoch seconds vs epoch ms timestamps', () => {
    const ms = 1735689600000; // 2025-01-01
    const sec = 1735689600;
    const a = parseMembership({ id: 'm', current_period_end: ms });
    const b = parseMembership({ id: 'm', current_period_end: sec });
    expect(a.currentPeriodEnd?.toISOString()).toBe(b.currentPeriodEnd?.toISOString());
  });

  it('returns a safe blank shape on garbage input', () => {
    const m = parseMembership(null);
    expect(m.id).toBe('');
    expect(m.status).toBe('expired');
    expect(m.metadata).toEqual({});
  });
});

describe('productIdToPlanTier', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      WHOP_PRODUCT_ID_MONTHLY: 'prod_m',
      WHOP_PRODUCT_ID_ANNUAL: 'prod_a',
      WHOP_PRODUCT_ID_LIFETIME: 'prod_l',
      WHOP_ADDON_PRODUCT_ID_AD_ACCOUNT: 'prod_addon',
    };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('maps each configured product id to its tier', () => {
    expect(productIdToPlanTier('prod_m')).toBe('monthly');
    expect(productIdToPlanTier('prod_a')).toBe('annual');
    expect(productIdToPlanTier('prod_l')).toBe('lifetime');
  });

  it('returns null for the add-on (not a plan tier — handled separately)', () => {
    expect(productIdToPlanTier('prod_addon')).toBeNull();
    expect(isAddOnAdAccountProduct('prod_addon')).toBe(true);
  });

  it('returns null for an unknown product id', () => {
    expect(productIdToPlanTier('prod_unknown')).toBeNull();
    expect(isAddOnAdAccountProduct('prod_unknown')).toBe(false);
  });
});
