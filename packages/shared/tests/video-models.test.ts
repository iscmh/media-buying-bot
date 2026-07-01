/**
 * Polish-20 Commit 1: descriptor coverage tests for the video-model
 * layer. Pins the launch model set, the launch provider matrix, and
 * the segment / preset / cost-hint math.
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_PROVIDER_CONFIGS,
  VIDEO_DURATION_PRESETS,
  VIDEO_MODELS,
  VIDEO_PROVIDERS,
  computeSegmentCountForModel,
  formatModelCostHintPerVariant,
  getDefaultProviderForModel,
  getLiveProvidersForModel,
  getModelProviderConfig,
  getVideoModel,
  getVideoProvider,
  snapToNearestDurationPreset,
  type VideoModelId,
} from '../src/video-models';

describe('Polish-20: VIDEO_MODELS launch set', () => {
  it('ships exactly three models: Seedance 1.5 Pro / Kling 3.0 Standard / Seedance 2', () => {
    expect(VIDEO_MODELS.map((m) => m.id)).toEqual([
      'seedance_1_5_pro',
      'kling_3_standard',
      'seedance_2',
    ]);
  });

  it('models are ordered budget → recommended → premium', () => {
    expect(VIDEO_MODELS.map((m) => m.qualityTier)).toEqual(['budget', 'recommended', 'premium']);
  });

  it('every model supports 9:16 (vertical UGC is the product spine)', () => {
    for (const m of VIDEO_MODELS) {
      expect(m.supportedAspectRatios).toContain('9:16');
    }
  });

  it('every model supports 720p (the launch quality target)', () => {
    for (const m of VIDEO_MODELS) {
      expect(m.supportedResolutions).toContain('720p');
    }
  });

  it('every model supports audio (Polish-20 spec: no ElevenLabs TTS step)', () => {
    for (const m of VIDEO_MODELS) {
      expect(m.supportsAudio).toBe(true);
    }
  });

  it('per-call caps: Seedance 1.5 Pro = 12s, Kling 3.0 = 15s, Seedance 2 = 15s', () => {
    expect(getVideoModel('seedance_1_5_pro')!.maxSingleCallSeconds).toBe(12);
    expect(getVideoModel('kling_3_standard')!.maxSingleCallSeconds).toBe(15);
    expect(getVideoModel('seedance_2')!.maxSingleCallSeconds).toBe(15);
  });

  it('no model REQUIRES a reference image at Polish-20 launch', () => {
    // All three support text-to-video natively; Nano Banana ref is
    // opt-in per variant in Polish-20 Commit 2's worker.
    for (const m of VIDEO_MODELS) {
      expect(m.requiresReferenceImage).toBe(false);
    }
  });
});

describe('Polish-20: VIDEO_PROVIDERS launch matrix', () => {
  it('ships four provider entries with only kie.ai live at launch', () => {
    expect(VIDEO_PROVIDERS.map((p) => p.id)).toEqual([
      'kie_ai',
      'fal_ai',
      'wavespeed',
      'atlas_cloud',
    ]);
    for (const p of VIDEO_PROVIDERS) {
      if (p.id === 'kie_ai') expect(p.liveAtLaunch).toBe(true);
      else expect(p.liveAtLaunch).toBe(false);
    }
  });

  it('every provider maps to a credential-provider key for the tool_connections lookup', () => {
    for (const p of VIDEO_PROVIDERS) {
      expect(p.requiredCredentialProvider.length).toBeGreaterThan(0);
    }
  });
});

describe('Polish-20: MODEL_PROVIDER_CONFIGS launch coverage', () => {
  it('every launch model has exactly ONE kie.ai config (Polish-21+ adds more)', () => {
    for (const m of VIDEO_MODELS) {
      const configs = MODEL_PROVIDER_CONFIGS.filter((c) => c.modelId === m.id);
      expect(configs).toHaveLength(1);
      expect(configs[0]!.providerId).toBe('kie_ai');
    }
  });

  it('confirmed per-second prices (user-verified against kie.ai catalog)', () => {
    expect(getModelProviderConfig('seedance_1_5_pro', 'kie_ai')!.usdPerSecond).toBe(0.035);
    expect(getModelProviderConfig('kling_3_standard', 'kie_ai')!.usdPerSecond).toBe(0.1);
    expect(getModelProviderConfig('seedance_2', 'kie_ai')!.usdPerSecond).toBe(0.33);
  });

  it('exact kie.ai model strings per verified docs', () => {
    expect(getModelProviderConfig('seedance_1_5_pro', 'kie_ai')!.modelParam).toBe(
      'bytedance/seedance-1.5-pro',
    );
    expect(getModelProviderConfig('kling_3_standard', 'kie_ai')!.modelParam).toBe(
      'kling-3.0/video',
    );
    expect(getModelProviderConfig('seedance_2', 'kie_ai')!.modelParam).toBe('bytedance/seedance-2');
  });

  it('every kie.ai config posts to the same createTask endpoint', () => {
    const url = 'https://api.kie.ai/api/v1/jobs/createTask';
    for (const c of MODEL_PROVIDER_CONFIGS) {
      if (c.providerId === 'kie_ai') expect(c.endpointUrl).toBe(url);
    }
  });
});

describe('Polish-20: per-model input-shape tripwires', () => {
  it('Seedance 1.5 Pro uses input_urls + generate_audio + duration:number + fixed_lens:true', () => {
    const shape = getModelProviderConfig('seedance_1_5_pro', 'kie_ai')!.inputShape;
    expect(shape.imageField).toBe('input_urls');
    expect(shape.audioField).toBe('generate_audio');
    expect(shape.durationField).toBe('duration');
    expect(shape.durationFormat).toBe('number');
    expect(shape.aspectRatioField).toBe('aspect_ratio');
    expect(shape.extras).toMatchObject({ fixed_lens: true, resolution: '720p' });
  });

  it('Kling 3.0 uses image_urls + sound + duration:STRING + mode:std + multi_shots:false', () => {
    const shape = getModelProviderConfig('kling_3_standard', 'kie_ai')!.inputShape;
    expect(shape.imageField).toBe('image_urls');
    // Docs call this out: Kling's audio flag is `sound`, NOT `generate_audio`.
    expect(shape.audioField).toBe('sound');
    // Docs call this out: Kling requires duration as a STRING enum.
    expect(shape.durationFormat).toBe('string');
    // Docs: 720p @ 9:16 comes from `mode: 'std'`; Kling has NO resolution field.
    expect(shape.extras).toMatchObject({ mode: 'std', multi_shots: false });
    expect(shape.extras).not.toHaveProperty('resolution');
  });

  it('Seedance 2 uses reference_image_urls + generate_audio + duration:number + resolution:720p', () => {
    const shape = getModelProviderConfig('seedance_2', 'kie_ai')!.inputShape;
    expect(shape.imageField).toBe('reference_image_urls');
    expect(shape.audioField).toBe('generate_audio');
    expect(shape.durationFormat).toBe('number');
    expect(shape.extras).toMatchObject({ resolution: '720p' });
  });
});

describe('Polish-20: getLiveProvidersForModel + getDefaultProviderForModel', () => {
  it('every launch model returns exactly one live provider (kie.ai)', () => {
    for (const m of VIDEO_MODELS) {
      const live = getLiveProvidersForModel(m.id);
      expect(live).toHaveLength(1);
      expect(live[0]!.id).toBe('kie_ai');
    }
  });

  it('the default provider is the cheapest live provider (kie.ai at Polish-20 launch)', () => {
    for (const m of VIDEO_MODELS) {
      expect(getDefaultProviderForModel(m.id)?.id).toBe('kie_ai');
    }
  });
});

describe('Polish-20: getVideoModel / getVideoProvider / getModelProviderConfig lookups', () => {
  it('returns undefined for unknown ids without throwing', () => {
    // Cast to sidestep the compile-time enum guard so we exercise the
    // runtime undefined path.
    expect(getVideoModel('nope' as VideoModelId)).toBeUndefined();
    expect(getVideoProvider('nope' as never)).toBeUndefined();
    expect(getModelProviderConfig('nope' as VideoModelId, 'nope' as never)).toBeUndefined();
  });

  it('resolves known ids to the matching descriptor', () => {
    expect(getVideoModel('kling_3_standard')?.qualityTier).toBe('recommended');
    expect(getVideoProvider('kie_ai')?.liveAtLaunch).toBe(true);
  });
});

describe('Polish-20: computeSegmentCountForModel', () => {
  const s15pro = getVideoModel('seedance_1_5_pro')!;
  const kling = getVideoModel('kling_3_standard')!;
  const s2 = getVideoModel('seedance_2')!;

  it('single-call presets (8s) → 1 segment on every model', () => {
    expect(computeSegmentCountForModel(s15pro, 8)).toBe(1);
    expect(computeSegmentCountForModel(kling, 8)).toBe(1);
    expect(computeSegmentCountForModel(s2, 8)).toBe(1);
  });

  it('15s target: 2 calls on Seedance 1.5 Pro (12s cap), 1 on Kling / Seedance 2 (15s cap)', () => {
    expect(computeSegmentCountForModel(s15pro, 15)).toBe(2);
    expect(computeSegmentCountForModel(kling, 15)).toBe(1);
    expect(computeSegmentCountForModel(s2, 15)).toBe(1);
  });

  it('30s target: 3 calls on Seedance 1.5 Pro, 2 on Kling / Seedance 2', () => {
    expect(computeSegmentCountForModel(s15pro, 30)).toBe(3);
    expect(computeSegmentCountForModel(kling, 30)).toBe(2);
    expect(computeSegmentCountForModel(s2, 30)).toBe(2);
  });

  it('60s target: 5 calls on Seedance 1.5 Pro, 4 on Kling / Seedance 2', () => {
    expect(computeSegmentCountForModel(s15pro, 60)).toBe(5);
    expect(computeSegmentCountForModel(kling, 60)).toBe(4);
    expect(computeSegmentCountForModel(s2, 60)).toBe(4);
  });

  it('runaway inputs clamp to the 8-segment sanity ceiling', () => {
    expect(computeSegmentCountForModel(s15pro, 600)).toBe(8);
    expect(computeSegmentCountForModel(kling, 600)).toBe(8);
    expect(computeSegmentCountForModel(s2, 9999)).toBe(8);
  });

  it('non-positive / non-finite input floors to 1 segment (safe default)', () => {
    expect(computeSegmentCountForModel(s15pro, 0)).toBe(1);
    expect(computeSegmentCountForModel(s15pro, -5)).toBe(1);
    expect(computeSegmentCountForModel(s15pro, NaN)).toBe(1);
    expect(computeSegmentCountForModel(s15pro, Infinity)).toBe(1);
  });
});

describe('Polish-20: VIDEO_DURATION_PRESETS + snapToNearestDurationPreset', () => {
  it('preset table matches the confirmed UX: 8s / 15s / 30s / 60s', () => {
    expect(VIDEO_DURATION_PRESETS).toEqual([8, 15, 30, 60]);
  });

  it('exact matches return their own preset', () => {
    for (const p of VIDEO_DURATION_PRESETS) {
      expect(snapToNearestDurationPreset(p)).toBe(p);
    }
  });

  it('missing / non-positive / non-finite → 30s default', () => {
    expect(snapToNearestDurationPreset(null)).toBe(30);
    expect(snapToNearestDurationPreset(undefined)).toBe(30);
    expect(snapToNearestDurationPreset(0)).toBe(30);
    expect(snapToNearestDurationPreset(-4)).toBe(30);
    expect(snapToNearestDurationPreset(NaN)).toBe(30);
  });

  it('between-preset values snap to the closer preset', () => {
    // Closer to 15 than 8 (delta: 15-13=2 vs 13-8=5)
    expect(snapToNearestDurationPreset(13)).toBe(15);
    // Closer to 30 than 15 (delta: 30-25=5 vs 25-15=10)
    expect(snapToNearestDurationPreset(25)).toBe(30);
    // Closer to 60 than 30 (delta: 60-50=10 vs 50-30=20)
    expect(snapToNearestDurationPreset(50)).toBe(60);
    // Just above the 8s preset — snaps to 8 (delta 3) not 15 (delta 4)
    expect(snapToNearestDurationPreset(11)).toBe(8);
  });

  it('above-ceiling values clamp to 60', () => {
    expect(snapToNearestDurationPreset(120)).toBe(60);
    expect(snapToNearestDurationPreset(9999)).toBe(60);
  });

  it('below-floor values clamp to 8', () => {
    expect(snapToNearestDurationPreset(1)).toBe(8);
    expect(snapToNearestDurationPreset(4)).toBe(8);
  });
});

describe('Polish-20: formatModelCostHintPerVariant', () => {
  it('produces the marketing-copy per-model / per-preset headline', () => {
    // Seedance 1.5 Pro at 30s: 30 × $0.035 = $1.05.
    expect(formatModelCostHintPerVariant('seedance_1_5_pro', 'kie_ai', 30)).toBe(
      '~$1.05 per 30s variant',
    );
    // Kling 3.0 Standard at 30s: 30 × $0.10 = $3.00.
    expect(formatModelCostHintPerVariant('kling_3_standard', 'kie_ai', 30)).toBe(
      '~$3.00 per 30s variant',
    );
    // Seedance 2 at 30s: 30 × $0.33 = $9.90.
    expect(formatModelCostHintPerVariant('seedance_2', 'kie_ai', 30)).toBe(
      '~$9.90 per 30s variant',
    );
  });

  it('returns empty string for unknown model+provider tuples', () => {
    expect(formatModelCostHintPerVariant('nope' as VideoModelId, 'kie_ai', 30)).toBe('');
  });
});
