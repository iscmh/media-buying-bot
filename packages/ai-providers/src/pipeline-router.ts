import type { DetectedFormatClass } from './vision-detection';

/**
 * Polish-6 item 2: auto-routing logic. Pure function that maps a
 * detected creative format + connected providers into the pipeline
 * the generation job should run through.
 *
 * Five pipeline types:
 *   heygen_avatar_talking_head        — HeyGen Avatar Mode (existing)
 *   sora_2_single_shot                — Sora 2 via OpenAI or Kie.ai
 *   kling_3_multi_clip_native_lipsync — 16-clip Kling 3.0 workflow
 *   nano_banana_static_image          — Gemini-based image gen
 *   + optional post_process: 'add_captions' for captioned UGC
 *
 * The routing is deterministic given (detection, connections,
 * preferences) — no randomness, no external calls.
 */

export type Pipeline =
  | 'heygen_avatar_talking_head'
  | 'sora_2_single_shot'
  | 'kling_3_multi_clip_native_lipsync'
  | 'nano_banana_static_image';

export type PostProcess = 'add_captions' | null;

export interface PickPipelineResult {
  ok: true;
  pipeline: Pipeline;
  tier?: 'free' | 'pro' | 'premium';
  postProcess: PostProcess;
}

export interface PickPipelineError {
  ok: false;
  errorMessage: string;
}

export interface UserConnections {
  heygen: { connected: boolean; tier?: 'free' | 'pro' | 'premium' | null };
  openai: { connected: boolean };
  kling: { connected: boolean };
  elevenlabs: { connected: boolean };
  gemini: { connected: boolean };
}

export interface UserPreferences {
  /** If set, force this pipeline regardless of detection. */
  overridePipeline?: Pipeline;
  /** Prefer Sora 2 over HeyGen for simple_ai_ugc when both are available. */
  preferSora?: boolean;
}

export function pickPipeline(
  detection: { format: DetectedFormatClass },
  connections: UserConnections,
  preferences: UserPreferences = {},
): PickPipelineResult | PickPipelineError {
  if (preferences.overridePipeline) {
    const valid = validatePipelineProviders(preferences.overridePipeline, connections);
    if (!valid.ok) return valid;
    return {
      ok: true,
      pipeline: preferences.overridePipeline,
      tier: connections.heygen.tier ?? undefined,
      postProcess: detection.format === 'ai_ugc_with_captions' ? 'add_captions' : null,
    };
  }

  switch (detection.format) {
    case 'static_image_ad':
      return pickStaticImage(connections);

    case 'simple_ai_ugc':
      return pickSimpleUgc(connections, preferences, null);

    case 'ai_ugc_with_captions':
      return pickSimpleUgc(connections, preferences, 'add_captions');

    case 'multi_scene_with_edits':
      return pickMultiScene(connections);
  }
}

function pickStaticImage(connections: UserConnections): PickPipelineResult | PickPipelineError {
  if (connections.gemini.connected) {
    return { ok: true, pipeline: 'nano_banana_static_image', postProcess: null };
  }
  return {
    ok: false,
    errorMessage: 'Connect Gemini on /connections/tools to generate static image variants.',
  };
}

function pickSimpleUgc(
  connections: UserConnections,
  preferences: UserPreferences,
  postProcess: PostProcess,
): PickPipelineResult | PickPipelineError {
  // Prefer Sora 2 if user has the keys and opted in (or Sora is the only option)
  if (connections.openai.connected && (preferences.preferSora || !connections.heygen.connected)) {
    return { ok: true, pipeline: 'sora_2_single_shot', postProcess };
  }
  if (connections.heygen.connected) {
    return {
      ok: true,
      pipeline: 'heygen_avatar_talking_head',
      tier: connections.heygen.tier ?? undefined,
      postProcess,
    };
  }
  if (connections.kling.connected) {
    return {
      ok: true,
      pipeline: 'kling_3_multi_clip_native_lipsync',
      postProcess,
    };
  }
  return {
    ok: false,
    errorMessage:
      'Connect HeyGen, OpenAI (Sora 2), or Replicate (Kling) on /connections to generate this format.',
  };
}

function pickMultiScene(connections: UserConnections): PickPipelineResult | PickPipelineError {
  if (connections.kling.connected) {
    return {
      ok: true,
      pipeline: 'kling_3_multi_clip_native_lipsync',
      postProcess: null,
    };
  }
  if (connections.openai.connected) {
    return { ok: true, pipeline: 'sora_2_single_shot', postProcess: null };
  }
  if (connections.heygen.connected) {
    return {
      ok: true,
      pipeline: 'heygen_avatar_talking_head',
      tier: connections.heygen.tier ?? undefined,
      postProcess: null,
    };
  }
  return {
    ok: false,
    errorMessage:
      'Connect Replicate (Kling) or OpenAI (Sora 2) on /connections to generate multi-scene variants.',
  };
}

function validatePipelineProviders(
  pipeline: Pipeline,
  connections: UserConnections,
): PickPipelineResult | PickPipelineError {
  switch (pipeline) {
    case 'heygen_avatar_talking_head':
      if (!connections.heygen.connected) {
        return { ok: false, errorMessage: 'Connect HeyGen to use the avatar pipeline.' };
      }
      return {
        ok: true,
        pipeline,
        tier: connections.heygen.tier ?? undefined,
        postProcess: null,
      };
    case 'sora_2_single_shot':
      if (!connections.openai.connected) {
        return { ok: false, errorMessage: 'Connect OpenAI to use the Sora 2 pipeline.' };
      }
      return { ok: true, pipeline, postProcess: null };
    case 'kling_3_multi_clip_native_lipsync':
      if (!connections.kling.connected) {
        return {
          ok: false,
          errorMessage: 'Connect Replicate (Kling) to use the multi-clip pipeline.',
        };
      }
      return { ok: true, pipeline, postProcess: null };
    case 'nano_banana_static_image':
      if (!connections.gemini.connected) {
        return {
          ok: false,
          errorMessage: 'Connect Gemini to use the static image pipeline.',
        };
      }
      return { ok: true, pipeline, postProcess: null };
  }
}

export function pipelineLabel(pipeline: Pipeline): string {
  switch (pipeline) {
    case 'heygen_avatar_talking_head':
      return 'HeyGen Avatar';
    case 'sora_2_single_shot':
      return 'Sora 2';
    case 'kling_3_multi_clip_native_lipsync':
      return 'Kling 3.0 Multi-Clip';
    case 'nano_banana_static_image':
      return 'Nano Banana Image';
  }
}
