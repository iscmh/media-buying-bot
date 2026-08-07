/**
 * Polish-27.0.0 Commit 63 tripwire: legacy UGC workers are
 * UNREGISTERED for the Polish-28 rebuild.
 *
 * The individual polish23/polish25/polish26 worker files stay on
 * disk (rollback = uncomment their imports + functions[] entries
 * in packages/jobs/src/functions/index.ts). What this test pins:
 *   - Their Inngest events are NOT in REGISTERED_GENERATION_WORKER_EVENTS.
 *   - refresh-heygen-avatar-index + refresh-makeugc-avatar-index
 *     cron function references are dropped from the functions[] array.
 *   - Static pipeline event 'generation/static-openai.requested'
 *     REMAINS registered (the sole surviving user-facing pipeline).
 *
 * If any of these asserts flip, either the rollback happened
 * intentionally (delete this file) or a merge conflict silently
 * re-added a registration. Fail loud instead of silent re-fire.
 */
import { describe, expect, it } from 'vitest';
import { REGISTERED_GENERATION_WORKER_EVENTS, functions } from '../src/functions';

const REGISTERED_EVENTS: ReadonlySet<string> =
  REGISTERED_GENERATION_WORKER_EVENTS as ReadonlySet<string>;

describe('Polish-27.0.0 Commit 63: legacy UGC workers UNREGISTERED', () => {
  it('polish23-veo-lite event is NOT registered', () => {
    expect(REGISTERED_EVENTS.has('generation/polish23-veo-lite.requested')).toBe(false);
  });

  it('polish25-makeugc event is NOT registered', () => {
    expect(REGISTERED_EVENTS.has('generation/polish25-makeugc.requested')).toBe(false);
  });

  it('polish26-heygen event is NOT registered', () => {
    expect(REGISTERED_EVENTS.has('generation/polish26-heygen.requested')).toBe(false);
  });

  it('static-openai event REMAINS registered (sole surviving user-facing pipeline)', () => {
    expect(REGISTERED_EVENTS.has('generation/static-openai.requested')).toBe(true);
  });

  it('functions[] array excludes the polish23/25/26 worker function objects', async () => {
    // Import the module symbols directly so a rename would fail here
    // (compile-time defense against future silent re-add).
    const { generatePolish23VeoLite } = await import('../src/functions/generate-polish23-veo-lite');
    const { generatePolish25Makeugc } = await import('../src/functions/generate-polish25-makeugc');
    const { generatePolish26Heygen } = await import('../src/functions/generate-polish26-heygen');
    expect(functions).not.toContain(generatePolish23VeoLite);
    expect(functions).not.toContain(generatePolish25Makeugc);
    expect(functions).not.toContain(generatePolish26Heygen);
  });

  it('functions[] array excludes the HeyGen + MakeUGC avatar-index sync crons', async () => {
    const { refreshHeygenAvatarIndexCron, refreshHeygenAvatarIndexManual } =
      await import('../src/functions/refresh-heygen-avatar-index');
    const { refreshMakeugcAvatarIndexCron, refreshMakeugcAvatarIndexManual } =
      await import('../src/functions/refresh-makeugc-avatar-index');
    expect(functions).not.toContain(refreshHeygenAvatarIndexCron);
    expect(functions).not.toContain(refreshHeygenAvatarIndexManual);
    expect(functions).not.toContain(refreshMakeugcAvatarIndexCron);
    expect(functions).not.toContain(refreshMakeugcAvatarIndexManual);
  });
});

describe('Polish-27.0.0 Commit 63: legacy code files preserved on disk (rollback path)', () => {
  it('polish23 worker module still exports its function symbol', async () => {
    const mod = await import('../src/functions/generate-polish23-veo-lite');
    expect(mod.generatePolish23VeoLite).toBeDefined();
  });

  it('polish25 makeugc worker module still exports its function symbol', async () => {
    const mod = await import('../src/functions/generate-polish25-makeugc');
    expect(mod.generatePolish25Makeugc).toBeDefined();
  });

  it('polish26 heygen worker module still exports its function symbol', async () => {
    const mod = await import('../src/functions/generate-polish26-heygen');
    expect(mod.generatePolish26Heygen).toBeDefined();
  });

  it('refresh-heygen-avatar-index module still exports both cron + manual symbols', async () => {
    const mod = await import('../src/functions/refresh-heygen-avatar-index');
    expect(mod.refreshHeygenAvatarIndexCron).toBeDefined();
    expect(mod.refreshHeygenAvatarIndexManual).toBeDefined();
  });

  it('refresh-makeugc-avatar-index module still exports both cron + manual symbols', async () => {
    const mod = await import('../src/functions/refresh-makeugc-avatar-index');
    expect(mod.refreshMakeugcAvatarIndexCron).toBeDefined();
    expect(mod.refreshMakeugcAvatarIndexManual).toBeDefined();
  });
});
