/**
 * Polish-6 item 2 → Polish-20 Commit 4: pipeline router tests for the
 * surviving legacy pipelines (HeyGen / Sora / Nano Banana).
 *
 * Kling multi-clip was removed in Commit 4; multi_scene_with_edits
 * now falls back through the same simple_ai_ugc branch (Sora or
 * HeyGen), and any override to the deleted Kling pipeline is a
 * compile-time error via the tightened Pipeline enum.
 */
import { describe, expect, it } from 'vitest';
import { pickPipeline, type UserConnections } from '../src/pipeline-router';

const ALL_CONNECTED: UserConnections = {
  heygen: { connected: true, tier: 'premium' },
  openai: { connected: true },
  gemini: { connected: true },
};

const NONE_CONNECTED: UserConnections = {
  heygen: { connected: false },
  openai: { connected: false },
  gemini: { connected: false },
};

describe('Polish-20 Commit 4: pickPipeline surviving routes', () => {
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

  it('simple_ai_ugc + nothing connected → error nudges toward simplified form', () => {
    const r = pickPipeline({ format: 'simple_ai_ugc' }, NONE_CONNECTED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMessage).toMatch(/Seedance|simplified form/);
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
  it('multi_scene_with_edits + heygen connected → heygen (Kling multi-clip deleted; falls through to simple UGC branch)', () => {
    const r = pickPipeline({ format: 'multi_scene_with_edits' }, ALL_CONNECTED);
    expect(r.ok).toBe(true);
    // ALL_CONNECTED without preferSora prefers HeyGen over Sora.
    if (r.ok) expect(r.pipeline).toBe('heygen_avatar_talking_head');
  });

  it('multi_scene_with_edits + only openai → sora', () => {
    const r = pickPipeline(
      { format: 'multi_scene_with_edits' },
      { ...NONE_CONNECTED, openai: { connected: true } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('sora_2_single_shot');
  });

  it('multi_scene_with_edits + nothing → error', () => {
    const r = pickPipeline({ format: 'multi_scene_with_edits' }, NONE_CONNECTED);
    expect(r.ok).toBe(false);
  });

  // === override ===
  it('override pipeline takes precedence over detection', () => {
    const r = pickPipeline({ format: 'simple_ai_ugc' }, ALL_CONNECTED, {
      overridePipeline: 'sora_2_single_shot',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pipeline).toBe('sora_2_single_shot');
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
