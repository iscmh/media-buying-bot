/**
 * Polish-20 Commit 1: descriptor coverage tests for the video-model
 * layer. Pins the launch model set, the launch provider matrix, and
 * the segment / preset / cost-hint math.
 */
import { describe, expect, it } from 'vitest';
import {
  HEDRA_VOICE_ROSTER,
  MODEL_PROVIDER_CONFIGS,
  VIDEO_DURATION_PRESETS,
  VIDEO_MODELS,
  VIDEO_PROVIDERS,
  computeHedraVoiceOffsetForJob,
  computeSegmentCountForModel,
  formatModelCostHintPerVariant,
  getDefaultHedraVoice,
  getDefaultProviderForModel,
  getLiveProvidersForModel,
  getModelProviderConfig,
  getVideoModel,
  getVideoProvider,
  isHedraVoiceRosterUncurated,
  pickHedraVoicesForBatch,
  snapToNearestDurationPreset,
  type HedraVoiceRosterEntry,
  type VideoModelId,
} from '../src/video-models';

/**
 * Polish-21: hidden-from-launcher seedance/kling entries are retained
 * in the descriptor through Commit 3 (worker + tests still reference
 * their config lookups). These helpers scope the launch-set
 * assertions to the non-hidden slice so Polish-21's launcher-visible
 * matrix is the single source of truth.
 */
const LAUNCHER_MODELS = VIDEO_MODELS.filter((m) => !m.hiddenFromLauncher);
const HIDDEN_LEGACY_MODELS = VIDEO_MODELS.filter((m) => m.hiddenFromLauncher);

describe('Polish-21: VIDEO_MODELS launcher-visible set', () => {
  it('ships exactly one launcher-visible model: Hedra Character 3', () => {
    expect(LAUNCHER_MODELS.map((m) => m.id)).toEqual(['hedra_character_3']);
  });

  it('retains three hidden legacy models for backwards compat: seedance_1_5_pro / kling_3_standard / seedance_2', () => {
    // Polish-21 Commit 3 physically removes these alongside
    // packages/ai-providers/src/kie-video.ts. Until then they stay
    // in the descriptor so kie-video worker paths still resolve.
    expect(HIDDEN_LEGACY_MODELS.map((m) => m.id)).toEqual([
      'seedance_1_5_pro',
      'kling_3_standard',
      'seedance_2',
    ]);
  });

  it('launcher-visible models are all recommended-tier (single sole model at launch)', () => {
    expect(LAUNCHER_MODELS.map((m) => m.qualityTier)).toEqual(['recommended']);
  });

  it('every launcher-visible model supports 9:16 (vertical UGC is the product spine)', () => {
    for (const m of LAUNCHER_MODELS) {
      expect(m.supportedAspectRatios).toContain('9:16');
    }
  });

  it('every launcher-visible model supports 720p (the launch quality target)', () => {
    for (const m of LAUNCHER_MODELS) {
      expect(m.supportedResolutions).toContain('720p');
    }
  });

  it('every launcher-visible model supports audio (Hedra Character 3 handles TTS natively)', () => {
    for (const m of LAUNCHER_MODELS) {
      expect(m.supportsAudio).toBe(true);
    }
  });

  it('per-call cap: Hedra Character 3 = 90s (single-call full video)', () => {
    expect(getVideoModel('hedra_character_3')!.maxSingleCallSeconds).toBe(90);
  });

  it('legacy models retain their Polish-20 per-call caps: Seedance 1.5 Pro = 12s, Kling 3.0 = 15s, Seedance 2 = 15s', () => {
    expect(getVideoModel('seedance_1_5_pro')!.maxSingleCallSeconds).toBe(12);
    expect(getVideoModel('kling_3_standard')!.maxSingleCallSeconds).toBe(15);
    expect(getVideoModel('seedance_2')!.maxSingleCallSeconds).toBe(15);
  });

  it('Hedra Character 3 REQUIRES a reference image (Nano Banana keyframe)', () => {
    expect(getVideoModel('hedra_character_3')!.requiresReferenceImage).toBe(true);
  });

  it('legacy models do NOT require a reference image (text-to-video native)', () => {
    for (const m of HIDDEN_LEGACY_MODELS) {
      expect(m.requiresReferenceImage).toBe(false);
    }
  });
});

describe('Polish-21: VIDEO_PROVIDERS launch matrix', () => {
  it('ships five provider entries: kie.ai + fal.ai + wavespeed + atlas_cloud + hedra', () => {
    expect(VIDEO_PROVIDERS.map((p) => p.id)).toEqual([
      'kie_ai',
      'fal_ai',
      'wavespeed',
      'atlas_cloud',
      'hedra',
    ]);
  });

  it('kie.ai + hedra live at launch (fal.ai / wavespeed / atlas_cloud dormant)', () => {
    for (const p of VIDEO_PROVIDERS) {
      if (p.id === 'kie_ai' || p.id === 'hedra') expect(p.liveAtLaunch).toBe(true);
      else expect(p.liveAtLaunch).toBe(false);
    }
  });

  it('every provider maps to a credential-provider key for the connection lookup', () => {
    for (const p of VIDEO_PROVIDERS) {
      expect(p.requiredCredentialProvider.length).toBeGreaterThan(0);
    }
  });

  it('hedra provider maps to the ai_provider_connections `hedra` key', () => {
    expect(getVideoProvider('hedra')!.requiredCredentialProvider).toBe('hedra');
  });
});

describe('Polish-21: MODEL_PROVIDER_CONFIGS launch coverage', () => {
  it('Hedra Character 3 has exactly one hedra config', () => {
    const configs = MODEL_PROVIDER_CONFIGS.filter((c) => c.modelId === 'hedra_character_3');
    expect(configs).toHaveLength(1);
    expect(configs[0]!.providerId).toBe('hedra');
  });

  it('Character 3 modelParam is the hardcoded ai_model_id UUID from hedra-labs/hedra-api-starter', () => {
    expect(getModelProviderConfig('hedra_character_3', 'hedra')!.modelParam).toBe(
      'd1dd37a3-e39a-4854-a298-6510289f9cf2',
    );
  });

  it('Character 3 posts to the public Hedra API base URL', () => {
    expect(getModelProviderConfig('hedra_character_3', 'hedra')!.endpointUrl).toBe(
      'https://api.hedra.com/web-app/public',
    );
  });

  it('legacy models retain their kie.ai configs pending Commit 3 deletion', () => {
    for (const m of HIDDEN_LEGACY_MODELS) {
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

describe('Polish-21: getLiveProvidersForModel + getDefaultProviderForModel', () => {
  it('Hedra Character 3 returns the hedra provider', () => {
    const live = getLiveProvidersForModel('hedra_character_3');
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe('hedra');
    expect(getDefaultProviderForModel('hedra_character_3')?.id).toBe('hedra');
  });

  it('legacy models return the kie.ai provider (until Commit 3 removes them)', () => {
    for (const m of HIDDEN_LEGACY_MODELS) {
      const live = getLiveProvidersForModel(m.id);
      expect(live).toHaveLength(1);
      expect(live[0]!.id).toBe('kie_ai');
      expect(getDefaultProviderForModel(m.id)?.id).toBe('kie_ai');
    }
  });
});

describe('Polish-21.0.4 hotfix: ELEVENLABS_VOICE_ROSTER (preset UUIDs) + helpers', () => {
  /**
   * Polish-21.0.4 hotfix rewrite: Hedra native TTS is blocked on
   * built-in voice UUIDs not being accessible on Creator plans
   * (Hedra returned "voice asset f412c62f-... not found" at submit
   * time). Pivot: worker generates audio via ElevenLabs BYOK and
   * uploads the mp3 as a Hedra audio_id asset. Roster is now 5
   * ElevenLabs preset voice UUIDs (public, available on every
   * ElevenLabs plan).
   *
   * HEDRA_VOICE_ROSTER (legacy alias) points at the same
   * ELEVENLABS_VOICE_ROSTER — downstream imports keep compiling.
   */
  const UUID_LIKE_RE = /^[A-Za-z0-9]{16,64}$/;
  const ELEVEN_SARAH_UUID = 'EXAVITQu4vr4xnSDxMaL';

  it('ships 5 preset ElevenLabs voice UUIDs at Polish-21.0.4 launch', () => {
    expect(HEDRA_VOICE_ROSTER).toHaveLength(5);
    expect(HEDRA_VOICE_ROSTER.map((v) => v.id)).toEqual([
      'EXAVITQu4vr4xnSDxMaL',
      'JBFqnCBsd6RMkjVDRZzb',
      'XB0fDUnXU5powFXDhCwa',
      'onwK4e9ZLuTAKqWW03F9',
      'TxGEqnHWrfWFTfGW9XjX',
    ]);
  });

  it('every roster entry id is UUID-shaped (regression against name-based ids)', () => {
    for (const v of HEDRA_VOICE_ROSTER) {
      expect(v.id, `voice ${JSON.stringify(v)} id is not UUID-shaped`).toMatch(UUID_LIKE_RE);
    }
  });

  it('every roster entry carries label + description + gender + age', () => {
    for (const v of HEDRA_VOICE_ROSTER) {
      expect(v.id.length).toBeGreaterThan(0);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
      expect(['female', 'male']).toContain(v.gender);
      expect(['young', 'middle_aged']).toContain(v.age);
    }
  });

  it('exactly ONE entry is marked isDefault: true (Sarah — safest neutral American)', () => {
    const defaults = HEDRA_VOICE_ROSTER.filter((v) => v.isDefault === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(ELEVEN_SARAH_UUID);
    expect(defaults[0]!.label).toBe('Sarah');
  });

  it('gender × age spread covers all four buckets (variant diversity)', () => {
    const buckets = new Set(HEDRA_VOICE_ROSTER.map((v) => `${v.gender}_${v.age}`));
    expect(buckets.has('female_young')).toBe(true);
    expect(buckets.has('male_young')).toBe(true);
    expect(buckets.has('female_middle_aged')).toBe(true);
    expect(buckets.has('male_middle_aged')).toBe(true);
  });

  it('getDefaultHedraVoice returns the Sarah preset UUID entry', () => {
    expect(getDefaultHedraVoice()?.id).toBe(ELEVEN_SARAH_UUID);
  });

  it('getDefaultHedraVoice falls back to first entry when no isDefault flag set', () => {
    const roster: HedraVoiceRosterEntry[] = [
      {
        id: 'a1b2c3d4e5f67890abcdef1234567890',
        label: 'a',
        description: 'a',
        gender: 'female',
        age: 'young',
      },
      {
        id: 'b1b2c3d4e5f67890abcdef1234567890',
        label: 'b',
        description: 'b',
        gender: 'male',
        age: 'young',
      },
    ];
    expect(getDefaultHedraVoice(roster)?.id).toBe(roster[0]!.id);
  });

  it('getDefaultHedraVoice returns undefined for an empty roster', () => {
    expect(getDefaultHedraVoice([])).toBeUndefined();
  });

  it('isHedraVoiceRosterUncurated returns false with the shipping 5-preset roster', () => {
    expect(isHedraVoiceRosterUncurated()).toBe(false);
  });

  it('isHedraVoiceRosterUncurated returns true only for a truly empty roster', () => {
    expect(isHedraVoiceRosterUncurated([])).toBe(true);
    expect(
      isHedraVoiceRosterUncurated([
        {
          id: 'a1b2c3d4e5f67890abcdef1234567890',
          label: 'x',
          description: 'x',
          gender: 'female',
          age: 'young',
        },
      ]),
    ).toBe(false);
  });

  it('pickHedraVoicesForBatch returns 5 distinct voices for the 5-preset roster (Polish-21.0.4 batch diversity)', () => {
    const picks = pickHedraVoicesForBatch(5);
    expect(picks).toHaveLength(5);
    // Polish-21.0.4 restores the batch-diversity guarantee — the
    // 5-preset ElevenLabs roster gives one distinct voice per
    // variant on a 5-batch. Rotate around the roster on offset=0.
    expect(new Set(picks.map((v) => v.id)).size).toBe(5);
  });

  it('pickHedraVoicesForBatch wraps when N > roster.length (variant 5 == roster[0])', () => {
    const picks = pickHedraVoicesForBatch(9);
    expect(picks).toHaveLength(9);
    // Regression pin: index 5 (6th call) wraps to roster[0].
    expect(picks[5]?.id).toBe(HEDRA_VOICE_ROSTER[0]!.id);
  });

  it('offset shifts the start position deterministically (multi-voice fixture roster)', () => {
    const roster: HedraVoiceRosterEntry[] = [
      {
        id: 'a1b2c3d4e5f67890abcdef1234567890',
        label: 'a',
        description: 'a',
        gender: 'female',
        age: 'young',
      },
      {
        id: 'b1b2c3d4e5f67890abcdef1234567890',
        label: 'b',
        description: 'b',
        gender: 'male',
        age: 'young',
      },
      {
        id: 'c1b2c3d4e5f67890abcdef1234567890',
        label: 'c',
        description: 'c',
        gender: 'female',
        age: 'middle_aged',
      },
    ];
    expect(pickHedraVoicesForBatch(3, 0, roster).map((v) => v.id)).toEqual([
      roster[0]!.id,
      roster[1]!.id,
      roster[2]!.id,
    ]);
    expect(pickHedraVoicesForBatch(3, 1, roster).map((v) => v.id)).toEqual([
      roster[1]!.id,
      roster[2]!.id,
      roster[0]!.id,
    ]);
    expect(pickHedraVoicesForBatch(3, 4, roster).map((v) => v.id)).toEqual([
      roster[1]!.id,
      roster[2]!.id,
      roster[0]!.id,
    ]);
    // Negative offsets normalize.
    expect(pickHedraVoicesForBatch(3, -1, roster).map((v) => v.id)).toEqual([
      roster[2]!.id,
      roster[0]!.id,
      roster[1]!.id,
    ]);
  });

  it('returns empty array for non-positive count or empty roster', () => {
    expect(pickHedraVoicesForBatch(0)).toEqual([]);
    expect(pickHedraVoicesForBatch(-1)).toEqual([]);
    expect(pickHedraVoicesForBatch(3, 0, [])).toEqual([]);
  });

  it('computeHedraVoiceOffsetForJob is deterministic per jobId (retries produce same picks)', () => {
    const a = computeHedraVoiceOffsetForJob('job-abc-123');
    const b = computeHedraVoiceOffsetForJob('job-abc-123');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
  });

  it('computeHedraVoiceOffsetForJob varies across job ids (batch-level diversity for a future multi-voice roster)', () => {
    // A single-entry roster collapses the offset to a no-op, but the
    // underlying hash MUST still vary across job ids so Polish-21.0.2's
    // multi-voice expansion lands the batch-diversity guarantee for
    // free. Fixture ids picked to avoid hash collisions.
    const ids = ['job-a', 'job-b', 'job-c', 'job-d', 'job-e', 'job-f'];
    const hashes = ids.map((id) => computeHedraVoiceOffsetForJob(id));
    expect(new Set(hashes).size).toBeGreaterThanOrEqual(2);
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
