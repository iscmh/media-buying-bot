/**
 * Polish-20: multi-model + multi-provider video-generation descriptor
 * layer.
 *
 * Replaces the Polish-6 PipelineType descriptors for the new video
 * pipeline (Seedance 1.5 Pro / Kling 3.0 Standard / Seedance 2).
 * Polish-20 Commit 1 ships this layer alongside the legacy pipeline
 * descriptors — nothing is deleted yet. Commits 3+4 delete the
 * legacy pipelines once the new worker is live.
 *
 * Two-axis config:
 *   - VideoModel:  the AI model itself (Seedance 1.5 Pro / Kling 3.0
 *                  Standard / Seedance 2). User-facing quality tier.
 *   - VideoProvider: WHERE the model runs (kie.ai / fal.ai / WaveSpeed
 *                  / Atlas Cloud). Same model on a different provider
 *                  = different endpoint / auth / price.
 *   - ModelProviderConfig: (model × provider) tuple with the runtime
 *                  data the worker needs — endpoint, model string, per-
 *                  field wire format, cost.
 *
 * Polish-20 launch: only kie.ai provider is `liveAtLaunch = true`.
 * Polish-21+ flips fal.ai / WaveSpeed / Atlas Cloud entries live as
 * their clients ship — no architectural change needed.
 *
 * Keeping this module PURE (no env, no DB, no I/O) so it runs client-
 * side in the form and server-side in the estimator / worker without
 * bundler complaints. Do NOT import anything from @mbb/db or
 * @mbb/ai-providers here.
 */

export type VideoModelId = 'seedance_1_5_pro' | 'kling_3_standard' | 'seedance_2';
export type VideoProviderId = 'kie_ai' | 'fal_ai' | 'wavespeed' | 'atlas_cloud';
export type VideoModelQualityTier = 'budget' | 'recommended' | 'premium';

/**
 * Wire format for the `duration` field. Kling 3.0 requires it as a
 * STRING enum ("3" through "15") while Seedance 1.5 Pro / Seedance 2
 * accept a number. The worker's per-provider client serializes
 * accordingly.
 */
export type VideoDurationWireFormat = 'number' | 'string';

/**
 * Per-model input-shape descriptor. Field NAMES vary across models
 * (Seedance 1.5 Pro uses `input_urls`, Kling uses `image_urls`,
 * Seedance 2 uses `reference_image_urls`) and audio flag NAMES vary
 * (`generate_audio` vs `sound`). Encoded here so the worker's
 * kie-video client can build the submit body from one config lookup
 * rather than a switch statement per model.
 */
export interface VideoModelInputShape {
  /** Field name for the text prompt (usually 'prompt'). */
  promptField: string;
  /** Field name for optional reference / first-frame image URL array. */
  imageField?: string;
  /** Field name for the audio-enable boolean ('generate_audio' vs 'sound'). */
  audioField: string;
  /** Field name for the video duration (usually 'duration'). */
  durationField: string;
  /** Wire format for the duration value — number for Seedance, string for Kling. */
  durationFormat: VideoDurationWireFormat;
  /** Field name for the aspect ratio. */
  aspectRatioField: string;
  /**
   * Extra input fields hardcoded per model (e.g. Seedance 1.5 Pro's
   * `fixed_lens: true` for UGC selfie stability, Kling's
   * `multi_shots: false` for single-shot mode, and per-model
   * resolution / mode selectors). Merged into the input body as-is.
   */
  extras?: Readonly<Record<string, unknown>>;
}

export interface VideoModel {
  id: VideoModelId;
  displayName: string;
  /** Sort key for the model picker (budget → recommended → premium). */
  qualityTier: VideoModelQualityTier;
  /** Card copy: 2-3 sentences of positioning shown under the display name. */
  description: string;
  /**
   * Per-call duration cap. Longer targets are chunked into N calls
   * (ceil(target / maxSingleCallSeconds)) and stitched via the
   * Polish-19.3 Replicate ffmpeg-concat helper.
   */
  maxSingleCallSeconds: number;
  supportedResolutions: readonly string[];
  supportedAspectRatios: readonly string[];
  /**
   * Whether the model requires a reference image input. None of the
   * Polish-20 launch models REQUIRE it — all support text-to-video.
   * Kept as a flag for future models (Kling Element mode / Seedance
   * 2's `@Image1` marker mode) that may.
   */
  requiresReferenceImage: boolean;
  supportsAudio: boolean;
}

export interface VideoProvider {
  id: VideoProviderId;
  displayName: string;
  /**
   * Polish-20: only kie.ai = true at launch. Flipping this to true
   * on another provider surfaces it in the form's provider picker
   * (Polish-21+) once its client is live.
   */
  liveAtLaunch: boolean;
  /**
   * BYOK key name in the tool_connections table (Polish-1.1). The
   * worker calls loadDecryptedKeys(userId, [requiredCredentialProvider])
   * to look up the API key. 'kie_ai' at Polish-20 launch; new entries
   * ('fal_ai' / 'wavespeed' / 'atlas_cloud') need matching enum
   * additions in packages/db/src/schema/enums.ts before their
   * provider entries flip live.
   */
  requiredCredentialProvider: string;
}

export interface ModelProviderConfig {
  modelId: VideoModelId;
  providerId: VideoProviderId;
  /** Price per second of GENERATED output in USD. */
  usdPerSecond: number;
  /** POST endpoint for the createTask call. */
  endpointUrl: string;
  /** Exact string sent in the request body's `model` field. */
  modelParam: string;
  inputShape: VideoModelInputShape;
}

// -------------------------------------------------------------------
// Config data
// -------------------------------------------------------------------

export const VIDEO_MODELS: readonly VideoModel[] = [
  {
    id: 'seedance_1_5_pro',
    displayName: 'Seedance 1.5 Pro',
    qualityTier: 'budget',
    description:
      'Cheapest option. Ships passable UGC for 40+ audiences. Best when you want a lot of variations for cheap.',
    maxSingleCallSeconds: 12,
    supportedResolutions: ['480p', '720p'],
    supportedAspectRatios: ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'],
    requiresReferenceImage: false,
    supportsAudio: true,
  },
  {
    id: 'kling_3_standard',
    displayName: 'Kling 3.0 Standard',
    qualityTier: 'recommended',
    description:
      'Best value. Materially better than Seedance 1.5 Pro at ~3× the price. The default recommendation for most UGC ads.',
    maxSingleCallSeconds: 15,
    supportedResolutions: ['720p'], // Polish-20 launch fixes mode=std (720p). Pro/4K exposed in Polish-21+.
    supportedAspectRatios: ['9:16', '16:9', '1:1'],
    requiresReferenceImage: false,
    supportsAudio: true,
  },
  {
    id: 'seedance_2',
    displayName: 'Seedance 2 (Pro)',
    qualityTier: 'premium',
    description:
      'Highest quality — near-real UGC that passes as authentic. Best for hero variants once you know what wins.',
    maxSingleCallSeconds: 15,
    supportedResolutions: ['480p', '720p', '1080p', '4k'],
    supportedAspectRatios: ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'],
    requiresReferenceImage: false,
    supportsAudio: true,
  },
];

export const VIDEO_PROVIDERS: readonly VideoProvider[] = [
  {
    id: 'kie_ai',
    displayName: 'kie.ai',
    liveAtLaunch: true,
    requiredCredentialProvider: 'kie_ai',
  },
  {
    id: 'fal_ai',
    displayName: 'fal.ai',
    liveAtLaunch: false,
    requiredCredentialProvider: 'fal_ai',
  },
  {
    id: 'wavespeed',
    displayName: 'WaveSpeed',
    liveAtLaunch: false,
    requiredCredentialProvider: 'wavespeed',
  },
  {
    id: 'atlas_cloud',
    displayName: 'Atlas Cloud',
    liveAtLaunch: false,
    requiredCredentialProvider: 'atlas_cloud',
  },
];

export const MODEL_PROVIDER_CONFIGS: readonly ModelProviderConfig[] = [
  {
    modelId: 'seedance_1_5_pro',
    providerId: 'kie_ai',
    usdPerSecond: 0.035,
    endpointUrl: 'https://api.kie.ai/api/v1/jobs/createTask',
    modelParam: 'bytedance/seedance-1.5-pro',
    inputShape: {
      promptField: 'prompt',
      imageField: 'input_urls',
      audioField: 'generate_audio',
      durationField: 'duration',
      durationFormat: 'number',
      aspectRatioField: 'aspect_ratio',
      extras: {
        // Polish-20 UGC spine: static-camera selfie shot. `fixed_lens: true`
        // keeps the camera pinned so lipsync + character continuity survive
        // across stitched segments. Multi-shot / dynamic camera is a
        // Polish-21+ Advanced-form exposure.
        fixed_lens: true,
        resolution: '720p',
      },
    },
  },
  {
    modelId: 'kling_3_standard',
    providerId: 'kie_ai',
    usdPerSecond: 0.1,
    endpointUrl: 'https://api.kie.ai/api/v1/jobs/createTask',
    modelParam: 'kling-3.0/video',
    inputShape: {
      promptField: 'prompt',
      imageField: 'image_urls',
      // Polish-20: Kling 3.0's audio flag is `sound` (not `generate_audio`
      // like Seedance). Docs call this out explicitly.
      audioField: 'sound',
      durationField: 'duration',
      // Polish-20: Kling requires duration as a STRING enum ("3".."15").
      // The worker's per-provider client serializes accordingly.
      durationFormat: 'string',
      aspectRatioField: 'aspect_ratio',
      extras: {
        // Polish-20: `mode: 'std'` selects 720p at 9:16 (720×1280).
        // Kling has no separate `resolution` field — resolution is
        // derived from (mode × aspect_ratio). Pro / 4K exposed in
        // Polish-21+ once we've validated 720p quality live.
        mode: 'std',
        // Single-shot UGC selfie — matches the Seedance `fixed_lens`
        // decision. Multi-shot cinematic exposure is Polish-21+.
        multi_shots: false,
      },
    },
  },
  {
    modelId: 'seedance_2',
    providerId: 'kie_ai',
    usdPerSecond: 0.33,
    endpointUrl: 'https://api.kie.ai/api/v1/jobs/createTask',
    modelParam: 'bytedance/seedance-2',
    inputShape: {
      promptField: 'prompt',
      // Polish-20: Seedance 2 uses `reference_image_urls` (per docs) —
      // referenced from the prompt via `@Image1` / `@Image2` markers.
      imageField: 'reference_image_urls',
      audioField: 'generate_audio',
      durationField: 'duration',
      durationFormat: 'number',
      aspectRatioField: 'aspect_ratio',
      extras: {
        resolution: '720p',
      },
    },
  },
];

// -------------------------------------------------------------------
// Lookup + math helpers
// -------------------------------------------------------------------

export function getVideoModel(id: VideoModelId): VideoModel | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

export function getVideoProvider(id: VideoProviderId): VideoProvider | undefined {
  return VIDEO_PROVIDERS.find((p) => p.id === id);
}

export function getModelProviderConfig(
  modelId: VideoModelId,
  providerId: VideoProviderId,
): ModelProviderConfig | undefined {
  return MODEL_PROVIDER_CONFIGS.find((c) => c.modelId === modelId && c.providerId === providerId);
}

/**
 * Return live provider entries that have a ModelProviderConfig for
 * the given model. At Polish-20 launch every live model has exactly
 * one live provider (kie.ai) so the picker never surfaces. Polish-21+
 * multi-provider models drive the price-comparison side-by-side UI.
 */
export function getLiveProvidersForModel(modelId: VideoModelId): VideoProvider[] {
  return VIDEO_PROVIDERS.filter((p) => p.liveAtLaunch && !!getModelProviderConfig(modelId, p.id));
}

/**
 * Cheapest live provider for a model. Used by the form to auto-route
 * when only one provider is live (Polish-20 launch state) OR when the
 * user hasn't explicitly picked (Polish-21+ default).
 */
export function getDefaultProviderForModel(modelId: VideoModelId): VideoProvider | undefined {
  const live = getLiveProvidersForModel(modelId);
  if (live.length === 0) return undefined;
  let cheapest = live[0]!;
  let cheapestPrice = getModelProviderConfig(modelId, cheapest.id)!.usdPerSecond;
  for (const p of live) {
    const c = getModelProviderConfig(modelId, p.id);
    if (c && c.usdPerSecond < cheapestPrice) {
      cheapest = p;
      cheapestPrice = c.usdPerSecond;
    }
  }
  return cheapest;
}

/**
 * Sanity cap on segment count — 8 is enough for 60s of Seedance 1.5
 * Pro (60/12=5) and 60s of Kling / Seedance 2 (60/15=4), which are
 * the highest UX presets. Beyond that the estimator quotes the cap
 * so runaway inputs don't blow up the form's cost preview.
 */
const VIDEO_MODEL_MAX_SEGMENTS = 8;

/**
 * Chunk math: how many N × maxSingleCallSeconds calls cover the
 * requested target. Ceil-based; the caller lands slightly-over
 * target when `target % maxSingleCallSeconds !== 0`.
 */
export function computeSegmentCountForModel(model: VideoModel, targetSeconds: number): number {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return 1;
  const raw = Math.ceil(targetSeconds / model.maxSingleCallSeconds);
  return Math.max(1, Math.min(VIDEO_MODEL_MAX_SEGMENTS, raw));
}

/**
 * Polish-20: 4-preset duration picker for the simplified form.
 * 8s / 15s / 30s / 60s — the UX-defensible bucket set the user
 * chose in the Polish-19.3 form. Advanced form retains free-form
 * entry for power users.
 */
export const VIDEO_DURATION_PRESETS: readonly number[] = [8, 15, 30, 60];

/**
 * Snap an auto-detected source-video duration to the nearest preset.
 * Ties resolve DOWN (cheaper preset) so a source that comes back at
 * 22.5s doesn't accidentally quote the more expensive 30s tier.
 */
export function snapToNearestDurationPreset(sourceSeconds: number | null | undefined): number {
  if (sourceSeconds == null || !Number.isFinite(sourceSeconds) || sourceSeconds <= 0) {
    return VIDEO_DURATION_PRESETS[2]!; // 30s default
  }
  let closest = VIDEO_DURATION_PRESETS[0]!;
  let closestDelta = Math.abs(closest - sourceSeconds);
  for (const p of VIDEO_DURATION_PRESETS) {
    const d = Math.abs(p - sourceSeconds);
    // Strict-less on ties → prefer the smaller preset (cheaper).
    if (d < closestDelta) {
      closest = p;
      closestDelta = d;
    }
  }
  return closest;
}

/**
 * Model card headline cost hint. Video-only pricing (excludes Claude
 * script + optional concat) so the operator sees the "raw" model
 * price for cross-model comparison. Full cost with overhead lives in
 * the form's estimator preview.
 */
export function formatModelCostHintPerVariant(
  modelId: VideoModelId,
  providerId: VideoProviderId,
  targetSeconds: number,
): string {
  const config = getModelProviderConfig(modelId, providerId);
  if (!config) return '';
  const videoUsd = targetSeconds * config.usdPerSecond;
  // Two-decimal formatting matches the estimator's display.
  return `~$${videoUsd.toFixed(2)} per ${Math.round(targetSeconds)}s variant`;
}
