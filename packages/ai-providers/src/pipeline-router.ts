import type { DetectedFormatClass } from './vision-detection';

/**
 * Polish-6 item 2 → Polish-20 Commit 4: auto-routing logic for the
 * surviving legacy pipelines.
 *
 * Pure function that maps a detected creative format + connected
 * providers into the pipeline the generation job should run through.
 * Post-Polish-20 the enum covers only:
 *   heygen_avatar_talking_head        — HeyGen Avatar Mode
 *   sora_2_single_shot                — Sora 2 via OpenAI or Kie.ai
 *   nano_banana_static_image          — Gemini-based image gen
 *
 * The new UGC video flow (Seedance / Kling 3.0 / Seedance 2) does
 * NOT route through here — it's driven by the simplified form's
 * mandatory model picker + generate-video-variant worker (see
 * @mbb/shared video-models.ts). This router is retained only for
 * legacy `simple_ai_ugc` / `multi_scene_with_edits` fall-throughs
 * where the user hasn't picked a model but still has a HeyGen /
 * Sora / static-image concept.
 *
 * Routing is deterministic given (detection, connections, preferences)
 * — no randomness, no external calls.
 */

export type Pipeline =
  | 'heygen_avatar_talking_head'
  | 'sora_2_single_shot'
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
      // Polish-20 Commit 4: Kling multi-clip pipeline deleted. Multi-
      // scene detection falls through to Sora/HeyGen; new video flow
      // routes users to the simplified-form model picker instead.
      return pickSimpleUgc(connections, preferences, null);
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
  return {
    ok: false,
    errorMessage:
      'Connect HeyGen or OpenAI (Sora 2) on /connections to generate this format. ' +
      'For the new Seedance / Kling 3.0 / Seedance 2 video pipeline, use the simplified form.',
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
    case 'nano_banana_static_image':
      return 'Nano Banana Image';
  }
}
