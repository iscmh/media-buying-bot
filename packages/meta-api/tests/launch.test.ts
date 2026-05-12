import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logMetaApiCall: vi.fn().mockResolvedValue(undefined),
}));

import { logMetaApiCall } from '@mbb/db';
import { createAd, createAdCreative, createAdSet, createCampaign } from '../src/launch';

const ORIGINAL_ENV = process.env;

describe('Phase 4a mock Meta CRUD — DRY_RUN gating', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'true' };
    vi.mocked(logMetaApiCall).mockClear();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('createCampaign returns a dry_run_campaign_* id in DRY_RUN', async () => {
    const result = await createCampaign({
      userId: 'u',
      adAccountId: 'act_123',
      name: 'Test campaign',
      objective: 'OUTCOME_SALES',
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.idKey).toBe('campaign_id');
    expect(result.id).toMatch(/^dry_run_campaign_[a-f0-9]{12}$/);
  });

  it('createAdSet returns a dry_run_adset_* id and forwards daily_budget as minor units', async () => {
    await createAdSet({
      userId: 'u',
      adAccountId: 'act_123',
      campaignId: 'dry_run_campaign_abc123',
      name: 'Test ad set',
      dailyBudgetUsd: 12.5,
      optimizationGoal: 'CONVERSIONS',
      placementType: 'advantage_plus',
    });
    expect(logMetaApiCall).toHaveBeenCalledTimes(1);
    const call = vi.mocked(logMetaApiCall).mock.calls[0]![0]!;
    expect((call.requestBody as { daily_budget?: number }).daily_budget).toBe(1250);
    expect(call.dryRun).toBe(true);
  });

  it('createAdCreative serializes headline / primary_text into link_data', async () => {
    await createAdCreative({
      userId: 'u',
      adAccountId: 'act_123',
      name: 'Creative',
      imageUrl: 'https://example.com/img.png',
      headline: 'Hook line',
      primaryText: 'Body copy',
      description: 'Tiny desc',
      destinationUrl: 'https://offer.example/landing',
      pageId: 'dry_run_page_id',
    });
    const call = vi.mocked(logMetaApiCall).mock.calls[0]![0]!;
    const body = call.requestBody as {
      object_story_spec: { link_data: { name: string; message: string; description?: string } };
    };
    expect(body.object_story_spec.link_data.name).toBe('Hook line');
    expect(body.object_story_spec.link_data.message).toBe('Body copy');
    expect(body.object_story_spec.link_data.description).toBe('Tiny desc');
  });

  it('createAd returns dry_run_ad_*', async () => {
    const result = await createAd({
      userId: 'u',
      adAccountId: 'act_123',
      adSetId: 'dry_run_adset_xyz',
      creativeId: 'dry_run_creative_xyz',
      name: 'Ad',
    });
    expect(result.id).toMatch(/^dry_run_ad_/);
    expect(result.ok).toBe(true);
  });

  it('throws in live mode (Phase 4b not implemented)', async () => {
    process.env.BOT_DRY_RUN = 'false';
    await expect(
      createCampaign({ userId: 'u', adAccountId: 'act_x', name: 'n', objective: 'OUTCOME_SALES' }),
    ).rejects.toThrow(/Phase 4b/);
  });

  it('audit-logs every call with dryRun=true', async () => {
    await createCampaign({
      userId: 'u',
      adAccountId: 'act_x',
      name: 'n',
      objective: 'OUTCOME_SALES',
    });
    expect(vi.mocked(logMetaApiCall)).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });
});
