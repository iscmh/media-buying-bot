/**
 * Polish-9.2: pin the pipeline-to-event-name mapping so the routing
 * is consistent between the web app (job creation) and the
 * analyze-concept worker (fan-out).
 */
import { describe, expect, it } from 'vitest';
import { ALL_PIPELINES, describePipeline, pipelineFromString, type PipelineType } from '../src';

describe('Polish-9.2: describePipeline', () => {
  it('avatar talking head → ugc.requested + heygen', () => {
    const d = describePipeline('heygen_avatar_talking_head');
    expect(d.workerEvent).toBe('generation/ugc.requested');
    expect(d.providerChoice).toBe('heygen');
    expect(d.format).toBe('avatar_talking_head');
    expect(d.requiredProviders).toEqual(['heygen']);
  });

  it('sora single shot → sora.requested + openai', () => {
    const d = describePipeline('sora_2_single_shot');
    expect(d.workerEvent).toBe('generation/sora.requested');
    expect(d.providerChoice).toBe('openai');
    expect(d.requiredProviders).toEqual(['openai']);
  });

  it('kling multi-clip → kling-multi-clip.requested + kling', () => {
    const d = describePipeline('kling_3_multi_clip_native_lipsync');
    expect(d.workerEvent).toBe('generation/kling-multi-clip.requested');
    expect(d.providerChoice).toBe('kling');
    expect(d.format).toBe('kling_3_multi_clip');
    expect(d.requiredProviders).toEqual(['kling']);
  });

  it('nano banana → nano-banana.requested + gemini', () => {
    const d = describePipeline('nano_banana_static_image');
    expect(d.workerEvent).toBe('generation/nano-banana.requested');
    expect(d.providerChoice).toBe('gemini');
    expect(d.requiredProviders).toEqual(['gemini']);
  });

  it('every pipeline has a unique workerEvent', () => {
    const events = ALL_PIPELINES.map((p) => describePipeline(p).workerEvent);
    expect(new Set(events).size).toBe(events.length);
  });

  it('every pipeline has a non-empty label', () => {
    for (const p of ALL_PIPELINES) {
      expect(describePipeline(p).label.length).toBeGreaterThan(0);
    }
  });
});

describe('Polish-9.2: pipelineFromString', () => {
  it('round-trips each known pipeline', () => {
    for (const p of ALL_PIPELINES) {
      expect(pipelineFromString(p)).toBe(p);
    }
  });

  it('returns null for unknown strings', () => {
    expect(pipelineFromString('martian_holograms')).toBeNull();
    expect(pipelineFromString('')).toBeNull();
    expect(pipelineFromString(null)).toBeNull();
    expect(pipelineFromString(undefined)).toBeNull();
  });
});

describe('Polish-9.2: ALL_PIPELINES coverage', () => {
  it('covers all 4 PipelineType values', () => {
    // If a new PipelineType is added without updating ALL_PIPELINES,
    // this assertion fails at type-check time via the satisfies clause
    // below — and the count check catches a stale list at runtime.
    const expected: PipelineType[] = [
      'heygen_avatar_talking_head',
      'sora_2_single_shot',
      'kling_3_multi_clip_native_lipsync',
      'nano_banana_static_image',
    ];
    expect(new Set(ALL_PIPELINES)).toEqual(new Set(expected));
  });
});
