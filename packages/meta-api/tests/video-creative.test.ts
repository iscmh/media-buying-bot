/**
 * Polish-3.6: video creative path tests.
 *
 * Coverage:
 *  - uploadAdVideo mock mode returns dry_run_video_*; doesn't fetch.
 *  - uploadAdVideo live mode hits graph-video.facebook.com and surfaces
 *    Meta errors with httpStatus + error_user_msg routing.
 *  - pollMetaVideoReady polls until video_status === 'ready', times out
 *    cleanly, fails fast on video_status='error'.
 *  - fetchMetaVideoThumbnail prefers is_preferred, falls back to first.
 *  - createAdCreative builds the video_data branch when media.kind ===
 *    'video', the link_data branch when media.kind === 'image'.
 *  - createAdCreative back-compat: passing imageHash directly keeps
 *    working (becomes media={kind:'image',imageHash}).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logMetaApiCall: vi.fn().mockResolvedValue(undefined),
  checkSpendSafety: vi.fn().mockResolvedValue({ allow: true }),
  reserveRateLimitSlot: vi.fn().mockResolvedValue(null),
  recordRateLimitHit: vi.fn().mockResolvedValue(undefined),
}));

import {
  createAdCreative,
  fetchMetaVideoThumbnail,
  pollMetaVideoReady,
  uploadAdVideo,
} from '../src/launch';

const ORIGINAL_ENV = process.env;
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, BOT_DRY_RUN: 'false' };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function mockFetchOnce(response: { status: number; body: unknown }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    text: async () => JSON.stringify(response.body),
    json: async () => response.body,
  } as Response) as typeof globalThis.fetch;
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const queue = [...responses];
  globalThis.fetch = vi.fn().mockImplementation(async () => {
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      text: async () => JSON.stringify(next.body),
      json: async () => next.body,
    } as Response;
  }) as typeof globalThis.fetch;
}

describe('uploadAdVideo', () => {
  it('mock mode returns dry_run_video_* without hitting Meta', async () => {
    process.env.BOT_DRY_RUN = 'true';
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const r = await uploadAdVideo({
      userId: 'u',
      accessToken: 'TOKEN',
      adAccountId: 'act_123',
      videoUrl: 'https://heygen.example/video.mp4',
      mode: 'live', // env override downgrades to mock
    });
    expect(r.ok).toBe(true);
    expect(r.videoId).toMatch(/^dry_run_video_/);
    expect(r.dryRun).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('live mode POSTs to graph-video.facebook.com and returns the video id', async () => {
    mockFetchOnce({ status: 200, body: { id: 'meta_video_999' } });
    const r = await uploadAdVideo({
      userId: 'u',
      accessToken: 'TOKEN',
      adAccountId: 'act_123',
      videoUrl: 'https://heygen.example/v.mp4',
      mode: 'live',
    });
    expect(r.ok).toBe(true);
    expect(r.videoId).toBe('meta_video_999');
    expect(r.dryRun).toBe(false);

    const call = (globalThis.fetch as unknown as { mock: { calls: [[string, RequestInit]] } }).mock
      .calls[0]!;
    expect(call[0]).toMatch(/graph-video\.facebook\.com/);
    expect(call[1].method).toBe('POST');
    expect(String(call[1].body)).toContain('file_url=');
    expect(String(call[1].body)).toContain('access_token=TOKEN');
  });

  it('surfaces Meta error_user_msg on 4xx', async () => {
    mockFetchOnce({
      status: 400,
      body: {
        error: {
          message: 'Invalid parameter',
          code: 100,
          error_user_msg: 'The video file is too short.',
        },
      },
    });
    const r = await uploadAdVideo({
      userId: 'u',
      accessToken: 'TOKEN',
      adAccountId: 'act_123',
      videoUrl: 'https://heygen.example/v.mp4',
      mode: 'live',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/too short/);
    expect(r.metaErrorCode).toBe(100);
  });
});

describe('pollMetaVideoReady', () => {
  it('returns ok when video_status reaches ready', async () => {
    mockFetchSequence([
      { status: 200, body: { status: { video_status: 'processing' } } },
      { status: 200, body: { status: { video_status: 'ready' } } },
    ]);
    const r = await pollMetaVideoReady({
      userId: 'u',
      accessToken: 'T',
      videoId: 'v',
      intervalMs: 1, // burn through ticks fast
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('ready');
  });

  it('fails fast when Meta reports video_status=error', async () => {
    mockFetchOnce({ status: 200, body: { status: { video_status: 'error' } } });
    const r = await pollMetaVideoReady({
      userId: 'u',
      accessToken: 'T',
      videoId: 'v',
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.errorMessage).toMatch(/video_status=error/);
  });

  it('times out cleanly with last seen status reported', async () => {
    mockFetchOnce({ status: 200, body: { status: { video_status: 'processing' } } });
    const r = await pollMetaVideoReady({
      userId: 'u',
      accessToken: 'T',
      videoId: 'v',
      intervalMs: 10,
      timeoutMs: 25,
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/within 0.025s|did not finish/);
  });
});

describe('fetchMetaVideoThumbnail', () => {
  it('picks the preferred entry when present', async () => {
    mockFetchOnce({
      status: 200,
      body: {
        data: [
          { uri: 'https://meta/thumb1.jpg', is_preferred: false },
          { uri: 'https://meta/thumb2.jpg', is_preferred: true },
        ],
      },
    });
    const r = await fetchMetaVideoThumbnail({ userId: 'u', accessToken: 'T', videoId: 'v' });
    expect(r.ok).toBe(true);
    expect(r.thumbnailUrl).toBe('https://meta/thumb2.jpg');
  });

  it('falls back to the first entry when none preferred', async () => {
    mockFetchOnce({
      status: 200,
      body: { data: [{ uri: 'https://meta/thumb1.jpg' }, { uri: 'https://meta/thumb2.jpg' }] },
    });
    const r = await fetchMetaVideoThumbnail({ userId: 'u', accessToken: 'T', videoId: 'v' });
    expect(r.ok).toBe(true);
    expect(r.thumbnailUrl).toBe('https://meta/thumb1.jpg');
  });

  it('errors when Meta returns no thumbnails', async () => {
    mockFetchOnce({ status: 200, body: { data: [] } });
    const r = await fetchMetaVideoThumbnail({ userId: 'u', accessToken: 'T', videoId: 'v' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/no thumbnails/);
  });
});

describe('createAdCreative — media dispatch', () => {
  it('image media builds link_data.image_hash payload', async () => {
    process.env.BOT_DRY_RUN = 'true'; // mock so we can inspect the logged body
    const { logMetaApiCall } = await import('@mbb/db');
    const r = await createAdCreative({
      userId: 'u',
      accessToken: 'T',
      adAccountId: 'act_123',
      name: 'CR — image',
      media: { kind: 'image', imageHash: 'IMGHASH' },
      headline: 'head',
      primaryText: 'body',
      destinationUrl: 'https://offer',
      pageId: 'page_1',
      mode: 'live',
    });
    expect(r.ok).toBe(true);

    const logged = vi.mocked(logMetaApiCall).mock.calls[0]![0];
    const body = logged.requestBody as {
      object_story_spec: { link_data?: { image_hash?: string }; video_data?: unknown };
    };
    expect(body.object_story_spec.link_data?.image_hash).toBe('IMGHASH');
    expect(body.object_story_spec.video_data).toBeUndefined();
  });

  it('video media builds video_data payload with thumbnail + CTA link.value', async () => {
    process.env.BOT_DRY_RUN = 'true';
    const { logMetaApiCall } = await import('@mbb/db');
    const r = await createAdCreative({
      userId: 'u',
      accessToken: 'T',
      adAccountId: 'act_123',
      name: 'CR — video',
      media: { kind: 'video', videoId: 'VIDX', thumbnailUrl: 'https://meta/t.jpg' },
      headline: 'head',
      primaryText: 'body',
      destinationUrl: 'https://offer',
      pageId: 'page_1',
      mode: 'live',
    });
    expect(r.ok).toBe(true);

    const logged = vi.mocked(logMetaApiCall).mock.calls[0]![0];
    const body = logged.requestBody as {
      object_story_spec: {
        link_data?: unknown;
        video_data?: {
          video_id?: string;
          image_url?: string;
          call_to_action?: { type?: string; value?: { link?: string } };
        };
      };
    };
    expect(body.object_story_spec.link_data).toBeUndefined();
    expect(body.object_story_spec.video_data?.video_id).toBe('VIDX');
    expect(body.object_story_spec.video_data?.image_url).toBe('https://meta/t.jpg');
    // Video CTAs put link on call_to_action.value, not link_data.link.
    expect(body.object_story_spec.video_data?.call_to_action?.value?.link).toBe('https://offer');
  });

  it('back-compat: passing imageHash directly still routes to link_data', async () => {
    process.env.BOT_DRY_RUN = 'true';
    const { logMetaApiCall } = await import('@mbb/db');
    const r = await createAdCreative({
      userId: 'u',
      accessToken: 'T',
      adAccountId: 'act_123',
      name: 'CR — legacy',
      imageHash: 'LEGACY_HASH',
      headline: 'head',
      primaryText: 'body',
      destinationUrl: 'https://offer',
      pageId: 'page_1',
      mode: 'live',
    });
    expect(r.ok).toBe(true);

    const logged = vi.mocked(logMetaApiCall).mock.calls[0]![0];
    const body = logged.requestBody as {
      object_story_spec: { link_data?: { image_hash?: string } };
    };
    expect(body.object_story_spec.link_data?.image_hash).toBe('LEGACY_HASH');
  });
});
