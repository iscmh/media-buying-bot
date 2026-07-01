/**
 * Polish-19.2.1: dispatch coverage tripwire. Pins that every
 * PipelineType in @mbb/shared's ALL_PIPELINES maps via its descriptor
 * to a workerEvent that's actually in the REGISTERED set in
 * functions/index.ts.
 *
 * The Polish-19.2 release shipped a new pipeline + worker correctly
 * wired in code, but the worker silently failed to pick up its
 * event on first live test — likely an Inngest function-sync gap
 * post-deploy. The user diagnosed it as a missing dispatch case;
 * the dispatch in analyze-concept WAS correct, but the operational
 * failure was indistinguishable from a missing-case bug from
 * outside.
 *
 * This test pins the failure mode at CI time: if a future pipeline
 * adds a PipelineType + descriptor but forgets to register the
 * worker (or vice-versa), one of these assertions fails before
 * deploy.
 *
 * It also pins the inverse: every event in REGISTERED has a
 * corresponding descriptor (catches a registered-but-never-routed
 * worker, which would still be a wiring bug worth knowing about).
 */
import { describe, expect, it } from 'vitest';
import { ALL_PIPELINES, describePipeline } from '@mbb/shared';
import { REGISTERED_GENERATION_WORKER_EVENTS } from '../src/functions';

// Widen the literal-typed Set to a string Set so cross-set comparisons
// don't trip TypeScript's narrow string-literal inference.
const REGISTERED: ReadonlySet<string> = REGISTERED_GENERATION_WORKER_EVENTS as ReadonlySet<string>;

describe('Polish-19.2.1: dispatch coverage between PipelineType and registered workers', () => {
  it('every PipelineType has a workerEvent registered to a worker', () => {
    const missing: Array<{ pipeline: string; event: string }> = [];
    for (const pipeline of ALL_PIPELINES) {
      const descriptor = describePipeline(pipeline);
      if (!REGISTERED.has(descriptor.workerEvent)) {
        missing.push({ pipeline, event: descriptor.workerEvent });
      }
    }
    if (missing.length > 0) {
      // Fail loudly with full diagnostic — the test output is the
      // operator's hint for where to add the missing wiring.
      throw new Error(
        `${missing.length} pipeline(s) reference workerEvent values that aren't ` +
          `in REGISTERED_GENERATION_WORKER_EVENTS:\n` +
          missing.map((m) => `  - ${m.pipeline} → ${m.event}`).join('\n') +
          `\n\nFix: register the worker in functions/index.ts ` +
          `(both REGISTERED_GENERATION_WORKER_EVENTS and the functions[] array).`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('every registered worker event maps to at least one PipelineType OR a non-pipeline path', () => {
    // The Set includes 'generation/static.requested' and
    // 'generation/ugc.requested' / 'cinematic.requested' that map to
    // PipelineTypes OR to the legacy format-based dispatch in
    // analyze-concept. The check below is a tripwire — if a registered
    // event has no descriptor reference AND isn't one of the
    // intentionally-non-pipeline-routed legacy events, surface it.
    const knownNonPipelineEvents = new Set([
      'generation/static.requested', // routed by sendGenerationJobEvent when conceptType=static
      'generation/ugc.requested', // default fallback in analyze-concept
      // Polish-20 Commit 2: unified video-variant worker. Not driven by
      // a legacy PipelineType descriptor — routed on metadata.model_id
      // in analyze-concept dispatch.
      'generation/video-variant.requested',
    ]);
    const allDescriptorEvents: ReadonlySet<string> = new Set<string>(
      ALL_PIPELINES.map((p) => describePipeline(p).workerEvent),
    );
    const orphanRegistered: string[] = [];
    for (const event of REGISTERED) {
      if (!allDescriptorEvents.has(event) && !knownNonPipelineEvents.has(event)) {
        orphanRegistered.push(event);
      }
    }
    if (orphanRegistered.length > 0) {
      throw new Error(
        `${orphanRegistered.length} registered worker event(s) have no descriptor reference ` +
          `and aren't documented as legacy / fallback paths:\n` +
          orphanRegistered.map((e) => `  - ${e}`).join('\n') +
          `\n\nEither (a) add a PipelineType + descriptor that routes to it, or ` +
          `(b) add it to knownNonPipelineEvents above with a comment explaining the routing.`,
      );
    }
    expect(orphanRegistered).toEqual([]);
  });

  it('Polish-20 Commit 4: surviving legacy pipelines still dispatch (HeyGen / Sora / Nano Banana)', () => {
    for (const p of [
      'heygen_avatar_talking_head',
      'sora_2_single_shot',
      'nano_banana_static_image',
    ] as const) {
      const d = describePipeline(p);
      expect(REGISTERED.has(d.workerEvent)).toBe(true);
    }
  });
});
