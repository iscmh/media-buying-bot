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
  deleteAdSet,
  deleteCampaign,
  effectiveLaunchMode,
  uploadAdImage,
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

  it('Phase 4b hotfix: createCampaign payload sets is_adset_budget_sharing_enabled=false', async () => {
    await createCampaign({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      name: 'sharing flag test',
      objective: 'OUTCOME_TRAFFIC',
      mode: 'mock',
    });
    const call = vi.mocked(logMetaApiCall).mock.calls[0]![0]!;
    expect(
      (call.requestBody as { is_adset_budget_sharing_enabled?: boolean })
        .is_adset_budget_sharing_enabled,
    ).toBe(false);
  });

  it('Phase 4b hotfix: createAdSet HARDCODES optimization_goal=LINK_CLICKS', async () => {
    await createAdSet({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      campaignId: 'dry_run_campaign_abc',
      name: 'opt-goal hardcode test',
      dailyBudgetUsd: 5,
      // User picked CONVERSIONS in settings — incompatible with our
      // OUTCOME_TRAFFIC campaign. Hardcode must override it.
      optimizationGoal: 'CONVERSIONS',
      placementType: 'advantage_plus',
      mode: 'mock',
    });
    const call = vi.mocked(logMetaApiCall).mock.calls[0]![0]!;
    expect((call.requestBody as { optimization_goal?: string }).optimization_goal).toBe(
      'LINK_CLICKS',
    );
  });

  it('createAdCreative serializes headline / primary_text into link_data', async () => {
    await createAdCreative({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      name: 'Creative',
      imageHash: 'dry_run_hash_abc123',
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
        link_data: {
          name: string;
          message: string;
          description?: string;
          image_hash?: string;
          image_url?: string;
        };
      };
    };
    expect(body.object_story_spec.link_data.name).toBe('Hook line');
    expect(body.object_story_spec.link_data.message).toBe('Body copy');
    expect(body.object_story_spec.link_data.description).toBe('Tiny desc');
  });

  it('Phase 4b hotfix #2: createAdCreative link_data uses image_hash, NOT image_url', async () => {
    await createAdCreative({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      name: 'image-hash-only',
      imageHash: 'dry_run_hash_xyz',
      headline: 'h',
      primaryText: 'p',
      destinationUrl: 'https://o.example',
      pageId: 'page_x',
      mode: 'mock',
    });
    const call = vi.mocked(logMetaApiCall).mock.calls[0]![0]!;
    const linkData = (
      call.requestBody as {
        object_story_spec: {
          link_data: { image_hash?: string; image_url?: string };
        };
      }
    ).object_story_spec.link_data;
    expect(linkData.image_hash).toBe('dry_run_hash_xyz');
    expect(linkData.image_url).toBeUndefined();
  });

  it('uploadAdImage returns dry_run_hash_* in mock mode', async () => {
    const result = await uploadAdImage({
      userId: 'u',
      accessToken: '',
      adAccountId: 'act_123',
      imageUrl: 'https://example.supabase.co/.../variant.png',
      mode: 'mock',
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.imageHash).toMatch(/^dry_run_hash_[a-f0-9]{12}$/);
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

describe('Phase 4b hotfix #2: uploadAdImage live path', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    vi.mocked(logMetaApiCall).mockClear();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('downloads the image, POSTs multipart to /adimages, returns Meta hash', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init ?? {} });
        if (url.includes('supabase')) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }
        // Meta /adimages response keys off the multipart field name —
        // 'creative.png' matches the field we send.
        return new Response(
          JSON.stringify({
            images: { 'creative.png': { hash: 'real_meta_hash_abc', url: 'cdn' } },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await uploadAdImage({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_123',
      imageUrl: 'https://stub.supabase.co/storage/v1/object/public/v.png',
      mode: 'live',
    });
    expect(result.ok).toBe(true);
    expect(result.imageHash).toBe('real_meta_hash_abc');

    // First call was the Supabase download, second was the multipart
    // POST to Meta with /adimages on the URL.
    expect(calls[0]!.url).toContain('supabase');
    expect(calls[1]!.url).toContain('/adimages');
    expect((calls[1]!.init as RequestInit).method).toBe('POST');
    // FormData boundary handling: do NOT pass a Content-Type header for
    // multipart (fetch sets it with the boundary).
    const headers = (calls[1]!.init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it("HOTFIX #3: multipart field is named '.png', NOT 'bytes' (Meta base64 magic keyword)", async () => {
    let capturedFormData: FormData | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('supabase')) {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        capturedFormData = (init as RequestInit).body as FormData;
        return new Response(
          JSON.stringify({
            images: { 'creative.png': { hash: 'h', url: 'cdn' } },
          }),
          { status: 200 },
        );
      }),
    );
    await uploadAdImage({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_123',
      imageUrl: 'https://stub.supabase.co/v.png',
      mode: 'live',
    });
    expect(capturedFormData).not.toBeNull();
    // Collect field names from the FormData.
    const iter = (
      capturedFormData! as unknown as {
        entries(): Iterable<[string, string | Blob]>;
      }
    ).entries();
    const names: string[] = [];
    for (const [name] of iter) names.push(name);
    expect(names).not.toContain('bytes');
    expect(names.some((n) => n.endsWith('.png'))).toBe(true);
  });

  it('returns ok=false when Meta /adimages 4xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('supabase')) {
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        }
        return new Response(
          JSON.stringify({ error: { message: 'invalid image', code: 1487001 } }),
          { status: 400 },
        );
      }),
    );
    const result = await uploadAdImage({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_123',
      imageUrl: 'https://stub.supabase.co/img.png',
      mode: 'live',
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/invalid image/);
    expect(result.metaErrorCode).toBe(1487001);
  });

  it('returns ok=false when Supabase download fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const result = await uploadAdImage({
      userId: 'u',
      accessToken: 'tok',
      adAccountId: 'act_123',
      imageUrl: 'https://stub.supabase.co/missing.png',
      mode: 'live',
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/HTTP 404/);
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

describe('Phase 4b hotfix #2: orphan cleanup helpers', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('deleteCampaign returns ok=true in mock mode (no fetch)', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'true' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await deleteCampaign({
      userId: 'u',
      accessToken: 'tok',
      objectId: '12345',
      mode: 'mock',
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deleteCampaign issues a DELETE to /<id> in live mode', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await deleteCampaign({
      userId: 'u',
      accessToken: 'tok',
      objectId: '52552097768220',
      mode: 'live',
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/52552097768220');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('deleteAdSet issues a DELETE to /<id> in live mode', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await deleteAdSet({
      userId: 'u',
      accessToken: 'tok',
      objectId: '52552097774020',
      mode: 'live',
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toContain('/52552097774020');
    expect((call[1] as RequestInit).method).toBe('DELETE');
  });

  it('delete helpers swallow 4xx — ok=false but no throw (best-effort)', async () => {
    process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'gone already', code: 100 } }), {
            status: 400,
          }),
      ),
    );
    const result = await deleteCampaign({
      userId: 'u',
      accessToken: 'tok',
      objectId: 'already_deleted',
      mode: 'live',
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/gone already/);
    // No throw — caller can move on.
  });
});
