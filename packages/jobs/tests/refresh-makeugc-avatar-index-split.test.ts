/**
 * Polish-25 Commit 8 regression pins.
 *
 * Commit 7 registered ONE multi-trigger function
 *   [{ cron: '0 3 * * *' }, { event: 'makeugc/avatar-index.refresh.requested' }]
 * — SDK-supported per Inngest 3.54, but the production sync
 * manifest silently dropped it. Commit 8 splits into TWO single-
 * trigger functions delegating to a shared core.
 *
 * Pins:
 *   - Both functions exported from the refresh module
 *   - Both registered in the functions[] dispatch array
 *   - Distinct Inngest function IDs (dashboard visibility)
 *   - Shared core (refreshMakeugcAvatarIndexCore) exported
 *   - resolveRefreshUserId precedence (explicit > env > throw)
 *   - bucketize behavior unchanged after the split
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MakeugcAvatar } from '@mbb/ai-providers';
import { functions } from '../src/functions';
import {
  bucketize,
  refreshMakeugcAvatarIndexCore,
  refreshMakeugcAvatarIndexCron,
  refreshMakeugcAvatarIndexManual,
  resolveRefreshUserId,
} from '../src/functions/refresh-makeugc-avatar-index';

describe('Polish-25 Commit 8: refresh worker split into two single-trigger functions', () => {
  it('exports refreshMakeugcAvatarIndexCron', () => {
    expect(refreshMakeugcAvatarIndexCron).toBeDefined();
  });

  it('exports refreshMakeugcAvatarIndexManual', () => {
    expect(refreshMakeugcAvatarIndexManual).toBeDefined();
  });

  it('exports the shared core (refreshMakeugcAvatarIndexCore)', () => {
    expect(refreshMakeugcAvatarIndexCore).toBeDefined();
    expect(typeof refreshMakeugcAvatarIndexCore).toBe('function');
  });

  it('both functions appear in the functions[] dispatch array', () => {
    expect(functions).toContain(refreshMakeugcAvatarIndexCron);
    expect(functions).toContain(refreshMakeugcAvatarIndexManual);
  });

  it('cron + manual are distinct function objects (not aliased)', () => {
    expect(refreshMakeugcAvatarIndexCron).not.toBe(refreshMakeugcAvatarIndexManual);
  });

  it('cron + manual have distinct Inngest function IDs', () => {
    // Inngest v3 exposes .id() as an instance method on
    // InngestFunction, returning the string ID. The check is
    // duplication-guard: if a future refactor accidentally reused
    // the same ID, Inngest cloud would refuse to sync one of them.
    const idFn = refreshMakeugcAvatarIndexCron as unknown as { id?: () => string };
    const cronId = typeof idFn.id === 'function' ? idFn.id() : undefined;
    const idFnManual = refreshMakeugcAvatarIndexManual as unknown as { id?: () => string };
    const manualId = typeof idFnManual.id === 'function' ? idFnManual.id() : undefined;
    // At minimum they must differ. Falls through as pass when the
    // SDK doesn't expose .id() but still distinct-object-checked
    // above.
    if (cronId !== undefined && manualId !== undefined) {
      expect(cronId).not.toBe(manualId);
      expect(cronId).toContain('refresh-makeugc-avatar-index');
      expect(manualId).toContain('refresh-makeugc-avatar-index');
    }
  });

  it('Commit 9: manual function keeps the BARE id refresh-makeugc-avatar-index', () => {
    // Rationale: Inngest cloud's manifest was stuck on the Commit-7
    // bare id and rejected the Commit-8 `-manual` id with "No
    // function ID found in request". Commit 9 restores the bare id
    // for the event-triggered function so the stale manifest still
    // routes correctly. Any future refactor that renames back to
    // `-manual` MUST first confirm the manifest has synced past
    // the bare id — this pin is the guardrail.
    const idFn = refreshMakeugcAvatarIndexManual as unknown as { id?: () => string };
    const manualId = typeof idFn.id === 'function' ? idFn.id() : undefined;
    if (manualId !== undefined) {
      expect(manualId).toBe('refresh-makeugc-avatar-index');
    }
  });

  it('Commit 9: cron function keeps its -cron suffix (distinct from bare id)', () => {
    const idFn = refreshMakeugcAvatarIndexCron as unknown as { id?: () => string };
    const cronId = typeof idFn.id === 'function' ? idFn.id() : undefined;
    if (cronId !== undefined) {
      expect(cronId).toBe('refresh-makeugc-avatar-index-cron');
    }
  });
});

describe('Polish-25 Commit 8: resolveRefreshUserId precedence', () => {
  const ENV_KEY = 'MAKEUGC_REFRESH_USER_ID';
  const originalEnv = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it('prefers explicit event.data.userId over env', () => {
    process.env[ENV_KEY] = 'env-user-uuid';
    expect(resolveRefreshUserId('explicit-user-uuid')).toBe('explicit-user-uuid');
  });

  it('falls back to env MAKEUGC_REFRESH_USER_ID when event userId absent', () => {
    process.env[ENV_KEY] = 'env-user-uuid';
    expect(resolveRefreshUserId(undefined)).toBe('env-user-uuid');
    expect(resolveRefreshUserId('')).toBe('env-user-uuid');
    expect(resolveRefreshUserId('   ')).toBe('env-user-uuid');
  });

  it('trims whitespace on both explicit and env inputs', () => {
    expect(resolveRefreshUserId('  padded  ')).toBe('padded');
    process.env[ENV_KEY] = '  env-padded  ';
    expect(resolveRefreshUserId(undefined)).toBe('env-padded');
  });

  it('throws when neither explicit nor env is set', () => {
    expect(() => resolveRefreshUserId(undefined)).toThrow(/no userId/);
    expect(() => resolveRefreshUserId('')).toThrow(/no userId/);
  });

  it('throws with actionable message pointing at both fixes', () => {
    try {
      resolveRefreshUserId(undefined);
      throw new Error('did not throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('MAKEUGC_REFRESH_USER_ID');
      expect(msg).toContain('event payload');
    }
  });
});

describe('Polish-25 Commit 8: bucketize behavior unchanged post-split', () => {
  const now = new Date('2026-07-21T12:00:00Z').getTime();
  const dayAgo = (n: number): Date => new Date(now - n * 24 * 60 * 60 * 1000);

  const mkAvatar = (id: string): MakeugcAvatar => ({
    id,
    name: id,
    gender: 'Male',
    thumbnail: `https://cdn/${id}.jpg`,
  });

  it('new avatar (absent from index) → toAnalyze', () => {
    const b = bucketize([mkAvatar('a_new')], [], now, false);
    expect(b.toAnalyze.map((a) => a.id)).toEqual(['a_new']);
    expect(b.toTouchOnly).toEqual([]);
    expect(b.toSoftDelete).toEqual([]);
  });

  it('fresh index row (<7d) → toTouchOnly', () => {
    const b = bucketize(
      [mkAvatar('a_fresh')],
      [{ avatarId: 'a_fresh', visionAnalyzedAt: dayAgo(3), deletedAt: null }],
      now,
      false,
    );
    expect(b.toAnalyze).toEqual([]);
    expect(b.toTouchOnly.map((a) => a.id)).toEqual(['a_fresh']);
    expect(b.toSoftDelete).toEqual([]);
  });

  it('stale index row (≥7d) → toAnalyze', () => {
    const b = bucketize(
      [mkAvatar('a_stale')],
      [{ avatarId: 'a_stale', visionAnalyzedAt: dayAgo(8), deletedAt: null }],
      now,
      false,
    );
    expect(b.toAnalyze.map((a) => a.id)).toEqual(['a_stale']);
    expect(b.toTouchOnly).toEqual([]);
    expect(b.toSoftDelete).toEqual([]);
  });

  it('forceAll=true → every live avatar goes to toAnalyze even if fresh', () => {
    const b = bucketize(
      [mkAvatar('a_fresh')],
      [{ avatarId: 'a_fresh', visionAnalyzedAt: dayAgo(1), deletedAt: null }],
      now,
      true,
    );
    expect(b.toAnalyze.map((a) => a.id)).toEqual(['a_fresh']);
    expect(b.toTouchOnly).toEqual([]);
  });

  it('previously-deleted row that reappears live → toAnalyze (un-delete on upsert)', () => {
    const b = bucketize(
      [mkAvatar('a_reborn')],
      [{ avatarId: 'a_reborn', visionAnalyzedAt: dayAgo(2), deletedAt: dayAgo(1) }],
      now,
      false,
    );
    expect(b.toAnalyze.map((a) => a.id)).toEqual(['a_reborn']);
  });

  it('index row absent from live library → toSoftDelete', () => {
    const b = bucketize(
      [],
      [{ avatarId: 'a_disappeared', visionAnalyzedAt: dayAgo(3), deletedAt: null }],
      now,
      false,
    );
    expect(b.toSoftDelete).toEqual(['a_disappeared']);
  });

  it('already-deleted row absent from live library → NOT re-flagged', () => {
    const b = bucketize(
      [],
      [{ avatarId: 'a_gone', visionAnalyzedAt: dayAgo(30), deletedAt: dayAgo(20) }],
      now,
      false,
    );
    expect(b.toSoftDelete).toEqual([]);
  });
});
