/**
 * Polish-28.0.0 Commit 64 tripwire: the cloned-UGC pipeline is
 * registered end-to-end.
 *
 * What this pins:
 *   - Its Inngest event is in REGISTERED_GENERATION_WORKER_EVENTS
 *   - Its worker function symbol is in functions[]
 *   - The pipeline descriptor is complete (label, providerChoice,
 *     format, workerEvent, requiredProviders all present and
 *     consistent with the descriptor's cross-file usage)
 *   - polish28_clone_ugc appears in ALL_PIPELINES (so
 *     dispatch-coverage.test.ts sees it)
 *   - Static ad pipeline still lives alongside it
 *
 * Inverse of the Commit-63 unregister tripwire — if Polish-28 ever
 * gets nuked (unlikely, but symmetry matters), these assertions
 * flip and CI surfaces the change.
 */
import { describe, expect, it } from 'vitest';
import { ALL_PIPELINES, describePipeline } from '@mbb/shared';
import { REGISTERED_GENERATION_WORKER_EVENTS, functions } from '../src/functions';

const REGISTERED_EVENTS: ReadonlySet<string> =
  REGISTERED_GENERATION_WORKER_EVENTS as ReadonlySet<string>;

describe('Polish-28.0.0 Commit 64: cloned-UGC pipeline registered', () => {
  it('polish28-clone-ugc event IS in REGISTERED_GENERATION_WORKER_EVENTS', () => {
    expect(REGISTERED_EVENTS.has('generation/polish28-clone-ugc.requested')).toBe(true);
  });

  it('polish28_clone_ugc appears in ALL_PIPELINES', () => {
    expect(ALL_PIPELINES).toContain('polish28_clone_ugc');
  });

  it('descriptor is complete + consistent', () => {
    const d = describePipeline('polish28_clone_ugc');
    expect(d.pipeline).toBe('polish28_clone_ugc');
    expect(d.workerEvent).toBe('generation/polish28-clone-ugc.requested');
    expect(d.format).toBe('polish28_clone_ugc');
    expect(d.providerChoice).toBe('clone_ugc');
    // The 4-BYOK requirement — every one must be present + no extras.
    expect(new Set(d.requiredProviders)).toEqual(
      new Set(['claude', 'gemini', 'elevenlabs', 'heygen']),
    );
    expect(d.label.toLowerCase()).toContain('cloned');
  });

  it('worker function symbol appears in functions[]', async () => {
    const { generatePolish28CloneUgc } =
      await import('../src/functions/generate-polish28-clone-ugc');
    expect(functions).toContain(generatePolish28CloneUgc);
  });

  it('static ad pipeline still lives alongside Polish-28', () => {
    expect(REGISTERED_EVENTS.has('generation/static-openai.requested')).toBe(true);
    expect(ALL_PIPELINES).toContain('static_openai_image');
  });
});
