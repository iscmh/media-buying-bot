/**
 * Polish-9.2: pin the pipeline-to-event-name mapping so the routing
 * is consistent between the web app (job creation) and the
 * analyze-concept worker (fan-out).
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_PIPELINES,
  defaultPipeline,
  describePipeline,
  pipelineFromString,
  type PipelineType,
} from '../src';

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

describe('Polish-19: defaultPipeline', () => {
  it('returns exactly one pipeline (the descriptor marked isDefault)', () => {
    const d = defaultPipeline();
    expect(ALL_PIPELINES).toContain(d);
    expect(describePipeline(d).isDefault).toBe(true);
  });

  it('only one descriptor is marked default at a time', () => {
    const defaults = ALL_PIPELINES.filter((p) => describePipeline(p).isDefault);
    expect(defaults).toHaveLength(1);
  });
});

describe('Polish-20 Commit 3: ALL_PIPELINES coverage post-Veo removal', () => {
  it('covers the remaining 7 PipelineType values (Veo deleted in Commit 3)', () => {
    const expected: PipelineType[] = [
      'heygen_avatar_talking_head',
      'sora_2_single_shot',
      'kling_3_multi_clip_native_lipsync',
      'kling_3_omni_multi_segment',
      'kie_omni_flash_native',
      'kie_kling_avatar_v2_standard',
      'nano_banana_static_image',
    ];
    expect(new Set(ALL_PIPELINES)).toEqual(new Set(expected));
  });
});

describe('Polish-20 Commit 3: kie_kling_avatar_v2_standard is the temporary legacy default', () => {
  it('routes to the kie-kling-avatar-v2.requested worker', () => {
    const d = describePipeline('kie_kling_avatar_v2_standard');
    expect(d.workerEvent).toBe('generation/kie-kling-avatar-v2.requested');
    expect(d.providerChoice).toBe('kling');
    expect(d.format).toBe('kie_kling_avatar_v2_standard');
  });

  it('requires the 4 providers the worker actually calls', () => {
    const d = describePipeline('kie_kling_avatar_v2_standard');
    expect(new Set(d.requiredProviders)).toEqual(
      new Set(['claude', 'gemini', 'kie_ai', 'elevenlabs']),
    );
  });

  it('carries isDefault=true — the form calls defaultPipeline() as a legacy signal until Commit 4', () => {
    expect(describePipeline('kie_kling_avatar_v2_standard').isDefault).toBe(true);
  });
});
