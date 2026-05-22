import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logMetaApiCall: vi.fn().mockResolvedValue(undefined),
  checkSpendSafety: vi.fn().mockResolvedValue({ allow: true }),
  reserveRateLimitSlot: vi.fn().mockResolvedValue(null),
  recordRateLimitHit: vi.fn().mockResolvedValue(undefined),
}));

import { getAdInsights } from '../src/insights';
import { pauseAd, scaleAdBudget } from '../src/lifecycle';

const ORIGINAL_ENV = process.env;

describe('Phase 5: getAdInsights', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('returns deterministic mock metrics in mock mode (no fetch)', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'true' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r1 = await getAdInsights({
      userId: 'u',
      accessToken: '',
      adId: 'ad-123',
      mode: 'mock',
    });
    const r2 = await getAdInsights({
      userId: 'u',
      accessToken: '',
      adId: 'ad-123',
      mode: 'mock',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Same input → same output.
    expect(r1.insights).toEqual(r2.insights);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses Meta /insights response shape in live mode', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              data: [
                {
                  spend: '15.50',
                  impressions: '2000',
                  clicks: '40',
                  frequency: '2.35',
                  actions: [
                    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
                    { action_type: 'link_click', value: '40' },
                  ],
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const r = await getAdInsights({
      userId: 'u',
      accessToken: 'tok',
      adId: 'real_ad_xyz',
      mode: 'live',
    });
    expect(r.ok).toBe(true);
    expect(r.insights?.spendUsd).toBe(15.5);
    expect(r.insights?.impressions).toBe(2000);
    expect(r.insights?.clicks).toBe(40);
    expect(r.insights?.conversions).toBe(3);
    expect(r.insights?.ctrPct).toBeCloseTo(2);
    expect(r.insights?.cpcUsd).toBeCloseTo(15.5 / 40);
    expect(r.insights?.frequency).toBeCloseTo(2.35);
  });

  it('also requests the frequency field from Meta', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await getAdInsights({
      userId: 'u',
      accessToken: 'tok',
      adId: 'ad_freq',
      mode: 'live',
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('frequency');
  });

  it('returns ok=false with Meta error on 4xx', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'ad not found', code: 100 } }), {
            status: 404,
          }),
      ),
    );
    const r = await getAdInsights({
      userId: 'u',
      accessToken: 'tok',
      adId: 'missing',
      mode: 'live',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/ad not found/);
  });
});

describe('Phase 5: pauseAd', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('sends status=PAUSED to the ad endpoint in live mode', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await pauseAd({
      userId: 'u',
      accessToken: 'tok',
      adId: 'ad_999',
      mode: 'live',
    });
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/ad_999');
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.status).toBe('PAUSED');
  });

  it('mock mode does not hit the network', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'true' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await pauseAd({
      userId: 'u',
      accessToken: 'tok',
      adId: 'ad_x',
      mode: 'live', // env override wins
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Phase 5: scaleAdBudget', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('sends daily_budget in minor units (cents) to the ad-set endpoint', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await scaleAdBudget({
      userId: 'u',
      accessToken: 'tok',
      adSetId: 'adset_abc',
      newDailyBudgetUsd: 12.5,
      mode: 'live',
    });
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/adset_abc');
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.daily_budget).toBe(1250);
  });

  it('surfaces Meta 4xx as ok=false', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'budget too small', code: 100 } }), {
            status: 400,
          }),
      ),
    );
    const r = await scaleAdBudget({
      userId: 'u',
      accessToken: 'tok',
      adSetId: 'adset_abc',
      newDailyBudgetUsd: 0.5,
      mode: 'live',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/budget too small/);
    expect(r.metaErrorCode).toBe(100);
  });
});
