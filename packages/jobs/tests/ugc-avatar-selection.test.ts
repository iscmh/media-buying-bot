/**
 * Phase 3f: UGC pipeline helpers — avatar selection priority + friendly
 * HeyGen error mapping.
 *
 * selectHeyGenAvatar priority:
 *   1. user_settings.default_heygen_avatar_id
 *   2. process.env.HEYGEN_DEFAULT_AVATAR_ID
 *   3. SMART_AVATAR_MATCH=true → heuristic match
 *   4. throw HeyGenAvatarNotConfiguredError
 *
 * Tests mock both the db query and listHeyGenAvatars so we can verify
 * priority without touching Postgres or the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.resetModules();
});

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.HEYGEN_DEFAULT_AVATAR_ID;
  delete process.env.SMART_AVATAR_MATCH;
});

function mockDbReturningSettings(value: { defaultHeygenAvatarId: string | null } | undefined) {
  vi.doMock('@mbb/db', () => ({
    getDb: () => ({
      query: {
        userSettings: { findFirst: vi.fn().mockResolvedValue(value) },
      },
    }),
    logAuditEvent: vi.fn().mockResolvedValue(undefined),
    schema: { userSettings: { userId: 'user_id' } },
  }));
}

function mockAvatarsList(
  avatars: Array<{ avatar_id: string; avatar_name: string; gender?: string }>,
) {
  vi.doMock('@mbb/ai-providers', async () => {
    const actual = await vi.importActual<typeof import('@mbb/ai-providers')>('@mbb/ai-providers');
    return {
      ...actual,
      listHeyGenAvatars: vi.fn().mockResolvedValue({
        ok: true,
        avatars,
        latencyMs: 1,
        httpStatus: 200,
      }),
    };
  });
}

describe('selectHeyGenAvatar', () => {
  it('returns user_settings.default_heygen_avatar_id when set', async () => {
    mockDbReturningSettings({ defaultHeygenAvatarId: 'avatar_from_settings' });
    process.env.HEYGEN_DEFAULT_AVATAR_ID = 'avatar_from_env'; // should NOT be used

    const { selectHeyGenAvatar } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatar({
      userId: 'u',
      apiKey: 'k',
      analysisMetadata: {},
      jobId: 'job',
    });

    expect(result).toBe('avatar_from_settings');
  });

  it('falls back to HEYGEN_DEFAULT_AVATAR_ID env var when user setting is null', async () => {
    mockDbReturningSettings({ defaultHeygenAvatarId: null });
    process.env.HEYGEN_DEFAULT_AVATAR_ID = 'avatar_from_env';

    const { selectHeyGenAvatar } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatar({
      userId: 'u',
      apiKey: 'k',
      analysisMetadata: {},
      jobId: 'job',
    });

    expect(result).toBe('avatar_from_env');
  });

  it('throws HeyGenAvatarNotConfiguredError when neither setting nor env is set', async () => {
    mockDbReturningSettings({ defaultHeygenAvatarId: null });
    // env var unset

    const { selectHeyGenAvatar } = await import('../src/functions/generate-ugc-variants');
    await expect(
      selectHeyGenAvatar({ userId: 'u', apiKey: 'k', analysisMetadata: {}, jobId: 'job' }),
    ).rejects.toThrow(/settings/);
  });

  it('treats an empty env var as unset', async () => {
    mockDbReturningSettings({ defaultHeygenAvatarId: null });
    process.env.HEYGEN_DEFAULT_AVATAR_ID = '   ';

    const { selectHeyGenAvatar } = await import('../src/functions/generate-ugc-variants');
    await expect(
      selectHeyGenAvatar({ userId: 'u', apiKey: 'k', analysisMetadata: {}, jobId: 'job' }),
    ).rejects.toThrow(/settings/);
  });

  it('only consults listHeyGenAvatars when SMART_AVATAR_MATCH=true', async () => {
    mockDbReturningSettings({ defaultHeygenAvatarId: null });
    process.env.SMART_AVATAR_MATCH = 'true';
    mockAvatarsList([
      { avatar_id: 'female_one', avatar_name: 'Daisy', gender: 'female' },
      { avatar_id: 'male_one', avatar_name: 'Tom', gender: 'male' },
    ]);

    const { selectHeyGenAvatar } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatar({
      userId: 'u',
      apiKey: 'k',
      // Persona vibes "female" — matcher should pick female_one.
      analysisMetadata: { analysis: { subject: { appearance: 'female' } } },
      jobId: 'job',
    });
    expect(result).toBe('female_one');
  });

  it('still throws if SMART_AVATAR_MATCH is on but no avatar matches', async () => {
    mockDbReturningSettings({ defaultHeygenAvatarId: null });
    process.env.SMART_AVATAR_MATCH = 'true';
    mockAvatarsList([]); // empty catalog

    const { selectHeyGenAvatar } = await import('../src/functions/generate-ugc-variants');
    await expect(
      selectHeyGenAvatar({ userId: 'u', apiKey: 'k', analysisMetadata: {}, jobId: 'job' }),
    ).rejects.toThrow(/settings/);
  });
});

describe('friendlyHeyGenError', () => {
  it('maps each error category to a user-facing message', async () => {
    mockDbReturningSettings(undefined);
    const { friendlyHeyGenError } = await import('../src/functions/generate-ugc-variants');

    expect(friendlyHeyGenError('auth', 'whatever')).toMatch(/Reconnect HeyGen/i);
    expect(friendlyHeyGenError('credits', 'whatever')).toMatch(/Top up.*credits/i);
    expect(friendlyHeyGenError('avatar_missing', 'whatever')).toMatch(/avatar/i);
    expect(friendlyHeyGenError('timeout', 'whatever')).toMatch(/too long/i);
    expect(friendlyHeyGenError('server', 'whatever')).toMatch(/server-side/i);
    expect(friendlyHeyGenError('unknown', 'raw HeyGen error')).toBe('raw HeyGen error');
    expect(friendlyHeyGenError('unknown', undefined)).toMatch(/HeyGen submission failed/);
  });
});
