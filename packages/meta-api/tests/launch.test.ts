import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logMetaApiCall: vi.fn().mockResolvedValue(undefined),
  checkSpendSafety: vi.fn().mockResolvedValue({ allow: true }),
  reserveRateLimitSlot: vi.fn().mockResolvedValue(null),
  recordRateLimitHit: vi.fn().mockResolvedValue(undefined),
}));

import { logMetaApiCall } from '@mbb/db';
import {
  createAd,
  createAdCreative,
  createAdSet,
  createCampaign,
  effectiveLaunchMode,
} from '../src/launch';

const ORIGINAL_ENV = process.env;

describe('Phase 4a mock Meta CRUD — DRY_RUN gating', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'true' };
    vi.mocked(logMetaApiCall).mockClear();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('createCampaign returns a dry_run_campaign_* id in mock mode', async () => {
    const result = await createCampaign({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      name: 'Test campaign',
      objective: 'OUTCOME_SALES',
      mode: 'mock',
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.idKey).toBe('campaign_id');
    expect(result.id).toMatch(/^dry_run_campaign_[a-f0-9]{12}$/);
  });

  it('createAdSet forwards daily_budget as minor units (cents)', async () => {
    await createAdSet({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      campaignId: 'dry_run_campaign_abc123',
      name: 'Test ad set',
      dailyBudgetUsd: 12.5,
      optimizationGoal: 'CONVERSIONS',
      placementType: 'advantage_plus',
      mode: 'mock',
    });
    expect(logMetaApiCall).toHaveBeenCalledTimes(1);
    const call = vi.mocked(logMetaApiCall).mock.calls[0]![0]!;
    expect((call.requestBody as { daily_budget?: number }).daily_budget).toBe(1250);
    expect(call.dryRun).toBe(true);
  });

  it('createAdCreative serializes headline / primary_text into link_data', async () => {
    await createAdCreative({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      name: 'Creative',
      imageUrl: 'https://example.com/img.png',
      headline: 'Hook line',
      primaryText: 'Body copy',
      description: 'Tiny desc',
      destinationUrl: 'https://offer.example/landing',
      pageId: 'dry_run_page_id',
      mode: 'mock',
    });
    const call = vi.mocked(logMetaApiCall).mock.calls[0]![0]!;
    const body = call.requestBody as {
      object_story_spec: {
        link_data: { name: string; message: string; description?: string };
      };
    };
    expect(body.object_story_spec.link_data.name).toBe('Hook line');
    expect(body.object_story_spec.link_data.message).toBe('Body copy');
    expect(body.object_story_spec.link_data.description).toBe('Tiny desc');
  });

  it('createAd returns dry_run_ad_* in mock mode', async () => {
    const result = await createAd({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      adSetId: 'dry_run_adset_xyz',
      creativeId: 'dry_run_creative_xyz',
      name: 'Ad',
      mode: 'mock',
    });
    expect(result.id).toMatch(/^dry_run_ad_/);
    expect(result.ok).toBe(true);
  });
});

describe('Phase 4b: HARDCODED status=PAUSED on every live payload', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    vi.mocked(logMetaApiCall).mockClear();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('every campaign / ad set / ad payload carries status=PAUSED in live mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'real_campaign_123' }), { status: 200 })),
    );
    await createCampaign({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_123',
      name: 'live test',
      objective: 'OUTCOME_TRAFFIC',
      mode: 'live',
    });
    // First call was the live fetch; check the body sent.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(sentBody.status).toBe('PAUSED');

    fetchMock.mockClear();
    await createAdSet({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_123',
      campaignId: 'real_campaign_123',
      name: 'live adset',
      dailyBudgetUsd: 5,
      optimizationGoal: 'LINK_CLICKS',
      placementType: 'advantage_plus',
      mode: 'live',
    });
    const adSetBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(adSetBody.status).toBe('PAUSED');

    fetchMock.mockClear();
    await createAd({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_123',
      adSetId: 'real_adset_xyz',
      creativeId: 'real_creative_xyz',
      name: 'live ad',
      mode: 'live',
    });
    const adBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(adBody.status).toBe('PAUSED');
  });
});

describe('Phase 4b: BOT_DRY_RUN env override wins over mode=live', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("effectiveLaunchMode('live') downgrades to mock when BOT_DRY_RUN=true", () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'true' };
    expect(effectiveLaunchMode('live')).toBe('mock');
  });

  it("effectiveLaunchMode('live') stays live when BOT_DRY_RUN=false", () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    expect(effectiveLaunchMode('live')).toBe('live');
  });

  it("effectiveLaunchMode('mock') is always mock regardless of env", () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    expect(effectiveLaunchMode('mock')).toBe('mock');
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'true' };
    expect(effectiveLaunchMode('mock')).toBe('mock');
  });

  it('createCampaign with mode=live + BOT_DRY_RUN=true returns dry_run id (no fetch)', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'true' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await createCampaign({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_x',
      name: 'n',
      objective: 'OUTCOME_TRAFFIC',
      mode: 'live',
    });
    expect(result.id).toMatch(/^dry_run_campaign_/);
    expect(result.dryRun).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Phase 4b: Meta error response surfaces in MetaCreateResult', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('4xx with structured Meta error returns ok=false + errorMessage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid ad account', code: 100 } }), {
            status: 400,
          }),
      ),
    );
    const result = await createCampaign({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_bad',
      name: 'n',
      objective: 'OUTCOME_TRAFFIC',
      mode: 'live',
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/Invalid ad account/);
    expect(result.metaErrorCode).toBe(100);
  });

  it('2xx without id field returns ok=false with explanatory message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 })),
    );
    const result = await createCampaign({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_x',
      name: 'n',
      objective: 'OUTCOME_TRAFFIC',
      mode: 'live',
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/no id field/);
  });
});
