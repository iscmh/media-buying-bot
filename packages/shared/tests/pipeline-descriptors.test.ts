/**
 * Polish-9.2 → Polish-20 Commit 4: pins the pipeline-to-event-name
 * mapping so routing stays consistent between the web app (job
 * creation) and analyze-concept (fan-out). Post-Commit-4 the
 * PipelineType enum is trimmed to the three legacy survivors
 * (HeyGen / Sora / Nano Banana); the new UGC video flow is
 * descriptor-driven via video-models.ts and NOT part of this table.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_PIPELINES,
  defaultPipeline,
  describePipeline,
  pipelineFromString,
  type PipelineType,
} from '../src';

describe('Polish-20 Commit 4: describePipeline surviving legacy descriptors', () => {
  it('HeyGen avatar talking head → ugc.requested', () => {
    const d = describePipeline('heygen_avatar_talking_head');
    expect(d.workerEvent).toBe('generation/ugc.requested');
    expect(d.providerChoice).toBe('heygen');
    expect(d.format).toBe('avatar_talking_head');
    expect(d.requiredProviders).toEqual(['heygen']);
  });

  it('Sora single shot → sora.requested', () => {
    const d = describePipeline('sora_2_single_shot');
    expect(d.workerEvent).toBe('generation/sora.requested');
    expect(d.providerChoice).toBe('openai');
    expect(d.requiredProviders).toEqual(['openai']);
  });

  it('Nano Banana → nano-banana.requested', () => {
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

describe('Polish-20 Commit 4: pipelineFromString round-trip', () => {
  it('round-trips each known pipeline', () => {
    for (const p of ALL_PIPELINES) {
      expect(pipelineFromString(p)).toBe(p);
    }
  });

  it('returns null for unknown strings + deleted pipelines', () => {
    expect(pipelineFromString('martian_holograms')).toBeNull();
    expect(pipelineFromString('')).toBeNull();
    expect(pipelineFromString(null)).toBeNull();
    expect(pipelineFromString(undefined)).toBeNull();
    // Post-Commit-4 the four legacy Kling/Omni pipelines no longer
    // parse — the enum is gone.
    expect(pipelineFromString('kling_3_multi_clip_native_lipsync')).toBeNull();
    expect(pipelineFromString('kling_3_omni_multi_segment')).toBeNull();
    expect(pipelineFromString('kie_omni_flash_native')).toBeNull();
    expect(pipelineFromString('kie_kling_avatar_v2_standard')).toBeNull();
    expect(pipelineFromString('veo_3_1_fast_native_audio')).toBeNull();
  });
});

describe('Polish-20 Commit 4: defaultPipeline throws — no pipeline-level default', () => {
  it('throws with a clear "use ModelProviderConfig" message', () => {
    expect(() => defaultPipeline()).toThrow(/ModelProviderConfig/);
  });
});

describe('Polish-20 Commit 4 → Polish-29 Commit 115: ALL_PIPELINES coverage', () => {
  it('covers legacy survivors + Polish-25.3 + Polish-28 + Polish-29 pipelines', () => {
    // Polish-27.0.0 Commit 63 narrowed ALL_PIPELINES to REGISTERED
    // pipelines only (dispatch-coverage tripwire would otherwise
    // fail). polish23_higgsfield_veo_lite / polish25_makeugc /
    // polish26_heygen are still in DESCRIPTORS (their descriptor
    // entries stay for forensics) but not in ALL_PIPELINES until
    // their workers get re-registered.
    // Polish-28.0.0 Commit 64 added polish28_clone_ugc.
    // Polish-28.3.0 Commit 85 added polish28_variations_ugc.
    // Polish-29.0.6 Commit 115 added polish29_seedance (first
    // credits-mode pipeline).
    const expected: PipelineType[] = [
      'heygen_avatar_talking_head',
      'sora_2_single_shot',
      'nano_banana_static_image',
      'static_openai_image',
      'polish28_clone_ugc',
      'polish28_variations_ugc',
      'polish29_seedance',
    ];
    expect(new Set(ALL_PIPELINES)).toEqual(new Set(expected));
  });
});

describe('Polish-25.3 Commit 18b: static_openai_image descriptor pins', () => {
  it('routes to generation/static-openai.requested', () => {
    const d = describePipeline('static_openai_image');
    expect(d.workerEvent).toBe('generation/static-openai.requested');
  });

  it('requires claude + openai (no gemini/heygen/etc.)', () => {
    const d = describePipeline('static_openai_image');
    expect(new Set(d.requiredProviders)).toEqual(new Set(['claude', 'openai']));
  });

  it('surfaces friendly "Static ad" label — no enum strings leak', () => {
    // Regression pin for the Commit 18a copy-leak fix.
    const d = describePipeline('static_openai_image');
    expect(d.label).toBe('Static ad');
    expect(d.label).not.toMatch(/openai|gpt/i);
  });

  it('providerChoice column is "openai" — worker reads it, timeline maps it', () => {
    const d = describePipeline('static_openai_image');
    expect(d.providerChoice).toBe('openai');
  });
});
