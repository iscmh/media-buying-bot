/**
 * Polish-6 item 2: pipeline router tests. Every combo of detected
 * format × provider availability, plus the override path.
 */
import { describe, expect, it } from 'vitest';
import { pickPipeline, type UserConnections } from '../src/pipeline-router';

const ALL_CONNECTED: UserConnections = {
  heygen: { connected: true, tier: 'premium' },
  openai: { connected: true },
  kling: { connected: true },
  elevenlabs: { connected: true },
  gemini: { connected: true },
};

const NONE_CONNECTED: UserConnections = {
  heygen: { connected: false },
  openai: { connected: false },
  kling: { connected: false },
  elevenlabs: { connected: false },
  gemini: { connected: false },
};

describe('Polish-6: pickPipeline', () => {
  // === static_image_ad ===
  it('static_image_ad + gemini connected → nano_banana', () => {
    const r = pickPipeline({ format: 'static_image_ad' }, ALL_CONNECTED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('nano_banana_static_image');
  });

  it('static_image_ad + no gemini → error', () => {
    const r = pickPipeline({ format: 'static_image_ad' }, NONE_CONNECTED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMessage).toMatch(/Gemini/);
  });

  // === simple_ai_ugc ===
  it('simple_ai_ugc + heygen connected → heygen by default', () => {
    const r = pickPipeline(
      { format: 'simple_ai_ugc' },
      { ...NONE_CONNECTED, heygen: { connected: true, tier: 'free' } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pipeline).toBe('heygen_avatar_talking_head');
      expect(r.tier).toBe('free');
    }
  });

  it('simple_ai_ugc + heygen + openai + preferSora → sora', () => {
    const r = pickPipeline(
      { format: 'simple_ai_ugc' },
      { ...NONE_CONNECTED, heygen: { connected: true }, openai: { connected: true } },
      { preferSora: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('sora_2_single_shot');
  });

  it('simple_ai_ugc + only openai → sora (only option)', () => {
    const r = pickPipeline(
      { format: 'simple_ai_ugc' },
      { ...NONE_CONNECTED, openai: { connected: true } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('sora_2_single_shot');
  });

  it('simple_ai_ugc + only kling → kling as last resort', () => {
    const r = pickPipeline(
      { format: 'simple_ai_ugc' },
      { ...NONE_CONNECTED, kling: { connected: true } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('kling_3_multi_clip_native_lipsync');
  });

  it('simple_ai_ugc + nothing connected → error', () => {
    const r = pickPipeline({ format: 'simple_ai_ugc' }, NONE_CONNECTED);
    expect(r.ok).toBe(false);
  });

  // === ai_ugc_with_captions ===
  it('ai_ugc_with_captions → same as simple_ai_ugc but with postProcess=add_captions', () => {
    const r = pickPipeline(
      { format: 'ai_ugc_with_captions' },
      { ...NONE_CONNECTED, heygen: { connected: true } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pipeline).toBe('heygen_avatar_talking_head');
      expect(r.postProcess).toBe('add_captions');
    }
  });

  // === multi_scene_with_edits ===
  it('multi_scene_with_edits + kling → kling (preferred)', () => {
    const r = pickPipeline({ format: 'multi_scene_with_edits' }, ALL_CONNECTED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('kling_3_multi_clip_native_lipsync');
  });

  it('multi_scene_with_edits + only openai → sora', () => {
    const r = pickPipeline(
      { format: 'multi_scene_with_edits' },
      { ...NONE_CONNECTED, openai: { connected: true } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('sora_2_single_shot');
  });

  it('multi_scene_with_edits + only heygen → heygen fallback', () => {
    const r = pickPipeline(
      { format: 'multi_scene_with_edits' },
      { ...NONE_CONNECTED, heygen: { connected: true, tier: 'premium' } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('heygen_avatar_talking_head');
  });

  it('multi_scene_with_edits + nothing → error', () => {
    const r = pickPipeline({ format: 'multi_scene_with_edits' }, NONE_CONNECTED);
    expect(r.ok).toBe(false);
  });

  // === override ===
  it('override pipeline takes precedence over detection', () => {
    const r = pickPipeline({ format: 'simple_ai_ugc' }, ALL_CONNECTED, {
      overridePipeline: 'kling_3_multi_clip_native_lipsync',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('kling_3_multi_clip_native_lipsync');
  });

  it('override fails when required provider not connected', () => {
    const r = pickPipeline({ format: 'simple_ai_ugc' }, NONE_CONNECTED, {
      overridePipeline: 'sora_2_single_shot',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMessage).toMatch(/OpenAI/);
  });

  it('override for captions format preserves postProcess=add_captions', () => {
    const r = pickPipeline({ format: 'ai_ugc_with_captions' }, ALL_CONNECTED, {
      overridePipeline: 'sora_2_single_shot',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.postProcess).toBe('add_captions');
  });
});
