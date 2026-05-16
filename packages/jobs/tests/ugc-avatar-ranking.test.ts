/**
 * Phase 3g: selectHeyGenAvatars — the array variant.
 *
 * Coverage:
 *   - Forced override: when user_settings.default_heygen_avatar_id is set,
 *     returns an array of N identical entries (consistent branding path).
 *   - Smart match: when no override, asks Claude to rank the catalog and
 *     returns the top N UNIQUE ids.
 *   - Diversity guarantee: a generation of N variants produces N different
 *     avatar ids when the pool has ≥N entries.
 *   - Backfill: if Claude returns fewer than N matches, the remainder is
 *     filled from the unmatched pool (still unique).
 *   - Empty Claude ranking: falls back to env HEYGEN_DEFAULT_AVATAR_ID.
 *   - No HeyGen catalog: falls back to env.
 *   - All paths exhausted: throws HeyGenAvatarNotConfiguredError.
 *
 * Mocks @mbb/db (just userSettings query) and @mbb/ai-providers (the
 * listHeyGenAvatars + claudeRankAvatars helpers). Doesn't touch the
 * Inngest job — selectHeyGenAvatars is the pure function under test.
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
});

interface SettingsRow {
  defaultHeygenAvatarId: string | null;
  defaultHeygenVoiceId?: string | null;
}

function mockDb(settings: SettingsRow | undefined) {
  vi.doMock('@mbb/db', () => ({
    getDb: () => ({
      query: {
        userSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
      },
    }),
    logAuditEvent: vi.fn().mockResolvedValue(undefined),
    schema: { userSettings: { userId: 'user_id' } },
  }));
}

const DEFAULT_VOICES = [
  { voice_id: 'v_en_female_1', name: 'Friendly EN F', gender: 'female', language: 'en-US' },
  { voice_id: 'v_en_male_1', name: 'Friendly EN M', gender: 'male', language: 'en-US' },
  { voice_id: 'v_fr_female_1', name: 'FR F', gender: 'female', language: 'fr-FR' },
];

function mockProviders(
  opts: {
    avatars?: Array<{ avatar_id: string; avatar_name: string; gender?: string }>;
    ranking?: { ok: boolean; rankedIds?: string[]; errorMessage?: string; costUsd?: number };
    listOk?: boolean;
    voices?: Array<{ voice_id: string; name: string; gender?: string; language?: string }>;
    voicesOk?: boolean;
  } = {},
) {
  vi.doMock('@mbb/ai-providers', async () => {
    const actual = await vi.importActual<typeof import('@mbb/ai-providers')>('@mbb/ai-providers');
    return {
      ...actual,
      listHeyGenAvatars: vi.fn().mockResolvedValue({
        ok: opts.listOk ?? true,
        avatars: opts.avatars ?? [],
        latencyMs: 1,
        httpStatus: opts.listOk === false ? 500 : 200,
        errorMessage: opts.listOk === false ? 'mock list failure' : undefined,
      }),
      listHeyGenVoices: vi.fn().mockResolvedValue({
        ok: opts.voicesOk ?? true,
        voices: opts.voices ?? DEFAULT_VOICES,
        latencyMs: 1,
        httpStatus: opts.voicesOk === false ? 500 : 200,
        errorMessage: opts.voicesOk === false ? 'mock voices failure' : undefined,
      }),
      claudeRankAvatars: vi.fn().mockResolvedValue({
        ok: opts.ranking?.ok ?? true,
        rankedIds: opts.ranking?.rankedIds ?? [],
        costUsd: opts.ranking?.costUsd ?? 0.02,
        latencyMs: 100,
        errorMessage: opts.ranking?.errorMessage,
      }),
    };
  });
}

const CATALOG = [
  { avatar_id: 'f1', avatar_name: 'Daisy', gender: 'female' },
  { avatar_id: 'f2', avatar_name: 'Sarah', gender: 'female' },
  { avatar_id: 'f3', avatar_name: 'Amy', gender: 'female' },
  { avatar_id: 'm1', avatar_name: 'Tom', gender: 'male' },
  { avatar_id: 'm2', avatar_name: 'Jack', gender: 'male' },
];

describe('selectHeyGenAvatars — forced override', () => {
  it('returns N identical entries when user_settings.default_heygen_avatar_id is set', async () => {
    mockDb({ defaultHeygenAvatarId: 'forced_avatar' });
    mockProviders(); // voices still need to be picked even when avatar is forced
    process.env.HEYGEN_DEFAULT_AVATAR_ID = 'env_fallback'; // should be ignored

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 5,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.avatarIds).toHaveLength(5);
    expect(new Set(result.avatarIds).size).toBe(1);
    expect(result.avatarIds[0]).toBe('forced_avatar');
    expect(result.rankingCostUsd).toBe(0);
    // Voice still got picked (first English voice — avatar gender unknown
    // when the avatar comes from the forced-override path).
    expect(result.voiceIds).toHaveLength(5);
    expect(result.voiceIds.every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
  });
});

describe('selectHeyGenAvatars — smart match (default behavior)', () => {
  it('returns variantCount UNIQUE ids in Claude rank order', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: CATALOG,
      ranking: { ok: true, rankedIds: ['f2', 'f1', 'f3', 'm1', 'm2'] },
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 3,
      analysisMetadata: {},
      jobId: 'job',
    });

    expect(result.avatarIds).toEqual(['f2', 'f1', 'f3']);
    expect(new Set(result.avatarIds).size).toBe(3);
    expect(result.rankingCostUsd).toBe(0.02);
  });

  it('NEVER repeats the same avatar twice in one generation', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: CATALOG,
      ranking: { ok: true, rankedIds: ['f2', 'f1', 'f3', 'm1', 'm2'] },
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 5,
      analysisMetadata: {},
      jobId: 'job',
    });

    expect(result.avatarIds).toHaveLength(5);
    expect(new Set(result.avatarIds).size).toBe(5); // all distinct
  });

  it('backfills with shuffled remainder when Claude returns fewer matches than variants', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: CATALOG,
      // Claude returned only 2 ranked ids; pipeline needs 4
      ranking: { ok: true, rankedIds: ['f2', 'f1'] },
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 4,
      analysisMetadata: {},
      jobId: 'job',
    });

    expect(result.avatarIds).toHaveLength(4);
    // First two are Claude's ranking; remaining two come from the pool
    // not yet picked.
    expect(result.avatarIds.slice(0, 2)).toEqual(['f2', 'f1']);
    expect(new Set(result.avatarIds).size).toBe(4);
    // Backfilled ids are all from the catalog.
    const catalogIds = new Set(CATALOG.map((a) => a.avatar_id));
    for (const id of result.avatarIds) expect(catalogIds.has(id)).toBe(true);
  });
});

describe('selectHeyGenAvatars — fallback chain', () => {
  it('falls back to env when Claude ranking fails', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: CATALOG,
      ranking: { ok: false, errorMessage: 'rate limited' },
    });
    process.env.HEYGEN_DEFAULT_AVATAR_ID = 'env_fallback';

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 3,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.avatarIds).toEqual(['env_fallback', 'env_fallback', 'env_fallback']);
    expect(result.rankingCostUsd).toBe(0);
  });

  it('falls back to env when listHeyGenAvatars 5xx', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({ avatars: [], ranking: { ok: false }, listOk: false });
    process.env.HEYGEN_DEFAULT_AVATAR_ID = 'env_fallback';

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 2,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.avatarIds).toEqual(['env_fallback', 'env_fallback']);
  });

  it('falls back to env when HeyGen catalog is empty', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({ avatars: [], ranking: { ok: true, rankedIds: [] } });
    process.env.HEYGEN_DEFAULT_AVATAR_ID = 'env_fallback';

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 2,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.avatarIds).toEqual(['env_fallback', 'env_fallback']);
  });

  it('throws HeyGenAvatarNotConfiguredError when every fallback is exhausted', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({ avatars: [], ranking: { ok: true, rankedIds: [] } });
    // env unset

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    await expect(
      selectHeyGenAvatars({
        userId: 'u',
        heygenApiKey: 'h',
        claudeApiKey: 'c',
        variantCount: 2,
        analysisMetadata: {},
        jobId: 'job',
      }),
    ).rejects.toThrow(/settings/);
  });
});

describe('selectHeyGenAvatars — edge cases', () => {
  it('returns empty array when variantCount is 0', async () => {
    mockDb({ defaultHeygenAvatarId: 'forced_avatar' });
    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 0,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.avatarIds).toEqual([]);
  });

  it('still serves variantCount entries when pool is genuinely smaller', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: [{ avatar_id: 'only_one', avatar_name: 'Solo', gender: 'female' }],
      ranking: { ok: true, rankedIds: ['only_one'] },
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 3,
      analysisMetadata: {},
      jobId: 'job',
    });
    // Last-resort path: pad with repeats rather than fail the job.
    expect(result.avatarIds).toHaveLength(3);
    expect(result.avatarIds[0]).toBe('only_one');
  });
});

// =========================================================================
// Phase 3i — voice pairing.
// =========================================================================

describe('selectHeyGenAvatars — voice pairing', () => {
  it('pairs each variant with a gender-matched English voice', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: CATALOG,
      // Force a deterministic mix of female + male avatars in the result.
      ranking: { ok: true, rankedIds: ['f1', 'm1', 'f2', 'm2'] },
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 4,
      analysisMetadata: {},
      jobId: 'job',
    });

    expect(result.avatarIds).toEqual(['f1', 'm1', 'f2', 'm2']);
    expect(result.voiceIds).toEqual([
      'v_en_female_1', // f1 → female voice
      'v_en_male_1', // m1 → male voice
      'v_en_female_1', // f2 → female voice
      'v_en_male_1', // m2 → male voice
    ]);
  });

  it('forced voice override fills every slot regardless of avatar gender', async () => {
    mockDb({ defaultHeygenAvatarId: null, defaultHeygenVoiceId: 'forced_voice' });
    mockProviders({
      avatars: CATALOG,
      ranking: { ok: true, rankedIds: ['f1', 'm1'] },
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 2,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.voiceIds).toEqual(['forced_voice', 'forced_voice']);
  });

  it('falls back to first English voice when no gender match exists', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: CATALOG,
      ranking: { ok: true, rankedIds: ['f1', 'f2'] },
      // Only male English voices available — female avatars get the
      // first English voice instead of failing.
      voices: [{ voice_id: 'v_en_m', name: 'Male EN', gender: 'male', language: 'en-US' }],
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 2,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.voiceIds).toEqual(['v_en_m', 'v_en_m']);
  });

  it('falls back to any voice when no English voice is available', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: CATALOG,
      ranking: { ok: true, rankedIds: ['f1'] },
      voices: [{ voice_id: 'v_fr_f', name: 'FR F', gender: 'female', language: 'fr-FR' }],
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 1,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.voiceIds).toEqual(['v_fr_f']);
  });

  it('throws when listHeyGenVoices fails AND no forced voice is configured', async () => {
    mockDb({ defaultHeygenAvatarId: null });
    mockProviders({
      avatars: CATALOG,
      ranking: { ok: true, rankedIds: ['f1'] },
      voicesOk: false,
    });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    await expect(
      selectHeyGenAvatars({
        userId: 'u',
        heygenApiKey: 'h',
        claudeApiKey: 'c',
        variantCount: 1,
        analysisMetadata: {},
        jobId: 'job',
      }),
    ).rejects.toThrow(/Could not load HeyGen voices/);
  });

  it('skips listHeyGenVoices entirely when a forced voice override is set', async () => {
    mockDb({ defaultHeygenAvatarId: 'forced_avatar', defaultHeygenVoiceId: 'forced_voice' });
    // Voices intentionally broken — must NOT be consulted because of the override.
    mockProviders({ voicesOk: false });

    const { selectHeyGenAvatars } = await import('../src/functions/generate-ugc-variants');
    const result = await selectHeyGenAvatars({
      userId: 'u',
      heygenApiKey: 'h',
      claudeApiKey: 'c',
      variantCount: 2,
      analysisMetadata: {},
      jobId: 'job',
    });
    expect(result.avatarIds).toEqual(['forced_avatar', 'forced_avatar']);
    expect(result.voiceIds).toEqual(['forced_voice', 'forced_voice']);
  });
});
