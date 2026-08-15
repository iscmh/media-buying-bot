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

export type VideoModelId =
  | 'seedance_1_5_pro'
  | 'kling_3_standard'
  | 'seedance_2'
  // Polish-21: Hedra Character 3 image-to-talking-avatar. Sole
  // user-facing model at launch — the seedance/kling entries stay
  // in the descriptor through Polish-21 Commit 3 for backwards
  // compat, then vanish alongside kie-video.ts.
  | 'hedra_character_3'
  // Polish-21.0.9: Kling AI Avatar v2 hosted on Hedra platform.
  // Same image-to-talking-avatar API shape as Character 3 (start
  // keyframe + audio asset + text prompt) but a different Hedra-
  // hosted model UUID. Standard is the new default (Recommended
  // tier); Pro is the Premium tier upgrade. Character 3 moves to
  // Budget tier — kept live so operators can compare outputs.
  | 'hedra_kling_avatar_v2_standard'
  | 'hedra_kling_avatar_v2_pro';
export type VideoProviderId = 'kie_ai' | 'fal_ai' | 'wavespeed' | 'atlas_cloud' | 'hedra';
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
   *
   * Polish-21: single-call models (Hedra Character 3, 90s cap) set
   * this to the full cap and the worker skips the concat step — the
   * ratio is what gates fan-out, not a per-model flag.
   */
  maxSingleCallSeconds: number;
  supportedResolutions: readonly string[];
  supportedAspectRatios: readonly string[];
  /**
   * Whether the model requires a reference image input. Polish-21:
   * hedra_character_3 REQUIRES the reference image (`start_keyframe`)
   * — the worker's Nano Banana Pro step gates on this flag before
   * submitting.
   */
  requiresReferenceImage: boolean;
  supportsAudio: boolean;
  /**
   * Polish-21: hidden from the form's model picker but still valid
   * for existing in-flight jobs. Used to phase out models while the
   * worker still knows how to look them up. Defaults to false
   * (visible in the picker) when omitted.
   */
  hiddenFromLauncher?: boolean;
  /**
   * Polish-21.0.10: per-model Hedra poll budget (max /status
   * attempts before the worker gives up). Character 3 typically
   * finishes in 30-90s (80 polls × ~5s = ~7min headroom); Kling
   * Avatar v2 Standard/Pro run materially longer (Hedra /models
   * eta_ms says Standard ≈ 5.3min, Pro ≈ 6.3min) so a Character-3
   * budget times out mid-generation on Kling.
   *
   *   Character 3           : 80 polls (~7 min headroom)
   *   Kling Avatar v2 Std   : 150 polls (~12.5 min headroom)
   *   Kling Avatar v2 Pro   : 200 polls (~16.7 min headroom)
   *
   * Ignored on non-Hedra models (kie.ai path has its own budget).
   * Undefined → worker uses HEDRA_POLL_MAX_ATTEMPTS default.
   */
  hedraPollMaxAttempts?: number;
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
  /**
   * Polish-21.0.10 hotfix: extra fields merged into Hedra's
   * `generated_video_inputs` block on submit. Model-specific
   * extension point — Character 3 opts into `enhance_prompt: false`
   * (Hedra accepts it and it prevents server-side prompt drift),
   * Kling Avatar v2 variants OMIT the field entirely because
   * Hedra's Kling backend rejects it with
   * `unrecognized_arguments: enhance_prompt` (job 305a9d15
   * diagnosed on first live Kling submit).
   *
   * Client-side (hedra-video.ts) does an object spread with the
   * base fields so nothing here can override text_prompt /
   * resolution / aspect_ratio / duration_ms. Ignored on non-Hedra
   * configs (kie.ai path builds its body from inputShape).
   */
  hedraExtraGeneratedVideoInputs?: Record<string, unknown>;
}

// -------------------------------------------------------------------
// Config data
// -------------------------------------------------------------------

export const VIDEO_MODELS: readonly VideoModel[] = [
  // Polish-21: seedance/kling entries stay hidden from the launcher
  // (hiddenFromLauncher: true) so existing metadata / dispatch code
  // paths still typecheck through Commit 2. Commit 3 physically
  // removes them alongside packages/ai-providers/src/kie-video.ts.
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
    hiddenFromLauncher: true,
  },
  {
    id: 'kling_3_standard',
    displayName: 'Kling 3.0 Standard',
    qualityTier: 'recommended',
    description:
      'Best value. Materially better than Seedance 1.5 Pro at ~3× the price. The default recommendation for most UGC ads.',
    maxSingleCallSeconds: 15,
    supportedResolutions: ['720p'],
    supportedAspectRatios: ['9:16', '16:9', '1:1'],
    requiresReferenceImage: false,
    supportsAudio: true,
    hiddenFromLauncher: true,
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
    hiddenFromLauncher: true,
  },
  {
    // Polish-21: Hedra Character 3. Image-to-talking-avatar. Single
    // call, up to 90s, no character drift, tight lip-sync. Reference
    // image comes from Nano Banana 2; audio from ElevenLabs BYOK
    // (Polish-21.0.4). Because it's single-call the worker skips
    // the multi-segment fan-out + Replicate concat entirely.
    //
    // Polish-21.0.9: demoted from `recommended` → `budget` tier
    // after Hedra's own /models catalog reclassified it as their
    // "last generation" avatar model (description: "Please use
    // Hedra Avatar instead"). Kept LIVE and launcher-visible so
    // operators can compare Kling v2 output against the working
    // Character 3 baseline before switching over.
    id: 'hedra_character_3',
    displayName: 'Hedra Character 3',
    qualityTier: 'budget',
    description:
      'Hedra prior-gen talking-avatar model. Reliable lip-sync + character continuity from a single reference image; use as a budget baseline.',
    maxSingleCallSeconds: 90,
    supportedResolutions: ['540p', '720p'],
    supportedAspectRatios: ['9:16', '16:9', '1:1'],
    requiresReferenceImage: true,
    supportsAudio: true,
    // Polish-21.0.10: Character 3 typically finishes 30-90s; 80
    // polls × 5s = ~7 minutes headroom, well past the tail.
    hedraPollMaxAttempts: 80,
  },
  {
    // Polish-21.0.9: Kling AI Avatar v2 Standard on Hedra.
    // Verified from live GET /models: id
    // `d7eb3b2e-c8f8-45f9-83db-34f18dd0ba85`, 720p only,
    // 60s max duration, 8 credits/sec (same base rate as
    // Character 3 — Hedra passes Kling through at their standard
    // credit rate, not fal.ai's $0.0562/sec passthrough).
    //
    // New RECOMMENDED tier default. Better character consistency
    // than Character 3 at the same per-second price on the
    // operator's Hedra plan.
    id: 'hedra_kling_avatar_v2_standard',
    displayName: 'Kling Avatar v2 Standard',
    qualityTier: 'recommended',
    description:
      'Kling v2 talking-avatar on Hedra. Better character consistency than Character 3 at the same price. Default pick for most UGC.',
    // 60s hard cap on Hedra (Kling Avatar v2 max_duration_ms).
    maxSingleCallSeconds: 60,
    supportedResolutions: ['720p'],
    supportedAspectRatios: ['9:16', '16:9', '1:1'],
    requiresReferenceImage: true,
    supportsAudio: true,
    // Polish-21.0.10: Kling Avatar v2 Standard runs materially
    // longer than Character 3 (Hedra /models eta_ms ≈ 5.3 min).
    // 150 polls × 5s = ~12.5 min headroom.
    hedraPollMaxAttempts: 150,
  },
  {
    // Polish-21.0.9: Kling AI Avatar v2 Pro on Hedra.
    // Verified from live GET /models: id
    // `0451ceea-a7b5-4275-a970-82bf4ef38055`, 720p only (Hedra
    // does NOT expose 1080p for Kling variants despite fal.ai's
    // direct passthrough listing 1080p), 60s max, 24 credits/sec
    // = ~$0.099/sec at the operator's Hedra rate ($0.033/8 =
    // $0.004125 per credit — same rate anchor as Character 3's
    // usdPerSecond).
    //
    // PREMIUM tier. Higher-fidelity motion + facial detail vs
    // Standard for hero variants.
    id: 'hedra_kling_avatar_v2_pro',
    displayName: 'Kling Avatar v2 Pro',
    qualityTier: 'premium',
    description:
      'Kling v2 Pro talking-avatar on Hedra. Sharper facial detail + smoother motion than Standard. Best for hero variants.',
    maxSingleCallSeconds: 60,
    supportedResolutions: ['720p'],
    supportedAspectRatios: ['9:16', '16:9', '1:1'],
    requiresReferenceImage: true,
    supportsAudio: true,
    // Polish-21.0.10: Kling Avatar v2 Pro runs even longer than
    // Standard (Hedra /models eta_ms ≈ 6.3 min at 60s output).
    // 200 polls × 5s = ~16.7 min headroom.
    hedraPollMaxAttempts: 200,
  },
];

export const VIDEO_PROVIDERS: readonly VideoProvider[] = [
  {
    id: 'kie_ai',
    displayName: 'kie.ai',
    // Polish-21: kie.ai stays as a live-at-launch entry through
    // Commit 3 (which removes it) so the Polish-20 seedance/kling
    // configs still resolve to a provider during the transition.
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
  {
    // Polish-21: Hedra Character 3 provider. BYOK key in
    // ai_provider_connections under provider='hedra' (see migration
    // 0032). Worker's Hedra branch loads it via
    // loadAiProviderKeys(userId, ['hedra']).
    id: 'hedra',
    displayName: 'Hedra',
    liveAtLaunch: true,
    requiredCredentialProvider: 'hedra',
  },
];

// -------------------------------------------------------------------
// Polish-21.0.9: default Hedra model UUID constants
// -------------------------------------------------------------------
//
// Verified from live GET https://api.hedra.com/web-app/public/models
// on 2026-07-04. Declared ahead of MODEL_PROVIDER_CONFIGS so the
// ModelProviderConfig entries can reference them by name (no
// duplicated UUID strings). The env resolver
// (getHedraModelIdWithEnvOverride in hedra-video.ts) takes ONE of
// these as its fallback argument and returns either the env
// override or the default.
//
// This module stays PURE (no env reads here).
export const DEFAULT_HEDRA_CHARACTER_3_MODEL_ID = 'd1dd37a3-e39a-4854-a298-6510289f9cf2';
export const DEFAULT_HEDRA_KLING_V2_STANDARD_MODEL_ID = 'd7eb3b2e-c8f8-45f9-83db-34f18dd0ba85';
export const DEFAULT_HEDRA_KLING_V2_PRO_MODEL_ID = '0451ceea-a7b5-4275-a970-82bf4ef38055';

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
  {
    // Polish-21: Hedra Character 3 config. The Hedra API uses a
    // different shape than kie.ai (asset upload + generation submit +
    // /status poll rather than createTask + recordInfo), so
    // `inputShape` here carries LEGACY-shaped placeholder field names
    // — the hedra-video client builds the real body from its own
    // typed input struct and IGNORES `inputShape`. The block is kept
    // populated so the ModelProviderConfig type check passes and the
    // per-model cost math still resolves the entry.
    //
    // ai_model_id verified from live GET
    // https://api.hedra.com/web-app/public/models
    // (see Polish-21.0.9 investigation).
    //
    // usdPerSecond: 0.033 per Polish-21 spec — base rate at Hedra Pro
    // tier (~8 credits/sec × ~$0.004125/credit). Actual per-credit
    // rate depends on the user's Hedra plan; the estimator surfaces
    // a range hint in the UI so operators aren't quoted a false
    // number. The Kling v2 entries below anchor to the SAME
    // $0.004125/credit rate so cross-model cost comparisons stay
    // apples-to-apples for the operator.
    modelId: 'hedra_character_3',
    providerId: 'hedra',
    usdPerSecond: 0.033,
    endpointUrl: 'https://api.hedra.com/web-app/public',
    modelParam: DEFAULT_HEDRA_CHARACTER_3_MODEL_ID,
    inputShape: {
      promptField: 'text_prompt',
      imageField: 'start_keyframe_id',
      audioField: '(hedra_manages_audio)',
      durationField: 'duration_ms',
      durationFormat: 'number',
      aspectRatioField: 'aspect_ratio',
      extras: {
        resolution: '720p',
      },
    },
    // Polish-21.0.10 hotfix: Character 3 accepts (and benefits
    // from) `enhance_prompt: false` to prevent Hedra's server-side
    // prompt-enhancer from rewriting our carefully-composed scene
    // description. Kling Avatar v2 REJECTS this field with
    // `unrecognized_arguments: enhance_prompt` (job 305a9d15
    // diagnosed), so it MUST stay off Kling configs.
    hedraExtraGeneratedVideoInputs: {
      enhance_prompt: false,
    },
  },
  {
    // Polish-21.0.9: Kling AI Avatar v2 Standard on Hedra. 8
    // credits/sec at the same $0.004125/credit rate anchor as
    // Character 3 → $0.033/sec identical passthrough. Motion +
    // character consistency both step up materially over
    // Character 3 for the same money, which is why this becomes
    // the new Recommended-tier default.
    //
    // Kling v2 on Hedra is 720p-only (does NOT expose 1080p even
    // though fal.ai's direct passthrough lists it); the client
    // pins '720p' at the submit call site.
    modelId: 'hedra_kling_avatar_v2_standard',
    providerId: 'hedra',
    usdPerSecond: 0.033,
    endpointUrl: 'https://api.hedra.com/web-app/public',
    modelParam: DEFAULT_HEDRA_KLING_V2_STANDARD_MODEL_ID,
    inputShape: {
      promptField: 'text_prompt',
      imageField: 'start_keyframe_id',
      audioField: '(hedra_manages_audio)',
      durationField: 'duration_ms',
      durationFormat: 'number',
      aspectRatioField: 'aspect_ratio',
      extras: {
        resolution: '720p',
      },
    },
  },
  {
    // Polish-21.0.9: Kling AI Avatar v2 Pro on Hedra. 24
    // credits/sec × $0.004125/credit = $0.099/sec.
    //
    // Sub-$0.115 fal.ai direct passthrough — Hedra bundles Kling
    // Pro at their standard credit rate, so operators on Hedra
    // Pro plans get Pro fidelity ~14% cheaper than fal.ai direct.
    modelId: 'hedra_kling_avatar_v2_pro',
    providerId: 'hedra',
    usdPerSecond: 0.099,
    endpointUrl: 'https://api.hedra.com/web-app/public',
    modelParam: DEFAULT_HEDRA_KLING_V2_PRO_MODEL_ID,
    inputShape: {
      promptField: 'text_prompt',
      imageField: 'start_keyframe_id',
      audioField: '(hedra_manages_audio)',
      durationField: 'duration_ms',
      durationFormat: 'number',
      aspectRatioField: 'aspect_ratio',
      extras: {
        resolution: '720p',
      },
    },
  },
];

// -------------------------------------------------------------------
// Polish-21.0.4 hotfix: ElevenLabs voice roster (replaces Hedra TTS)
// -------------------------------------------------------------------
//
// Polish-21 Commit 2 tried to use Hedra's native TTS voices.
// Polish-21.0.1 — .0.3 iterated on the shape (UUID vs name,
// duration_ms, poll URL) but all attempts hit Hedra returning
// "voice_asset f412c62f-... not found" at submit time because
// Hedra's built-in voice UUIDs aren't available on regular Creator
// plans and support hasn't responded on providing account-scoped
// UUIDs.
//
// Polish-21.0.4 hotfix pivots the pipeline to ElevenLabs TTS BYOK.
// User owns the voice choice via their ElevenLabs library; worker
// generates audio via ElevenLabs and uploads the mp3 as a Hedra
// audio asset. This also opens the source-voice-cloning path for
// Polish-22 (analyze source ad audio → ElevenLabs Instant Voice
// Clone → use that voice for all variants).
//
// The roster below carries ElevenLabs' well-known preset voice UUIDs
// (public, available on every plan) so a fresh operator install
// works with zero curation. Rotate through per-variant with
// pickElevenLabsVoicesForBatch for gender × age diversity.

export interface ElevenLabsVoiceRosterEntry {
  /**
   * ElevenLabs voice UUID. Passed as the URL path segment on
   * POST /v1/text-to-speech/{voice_id}.
   */
  id: string;
  /** Free-form display label — used in logs and worker debug output. */
  label: string;
  /** One-sentence positioning; goes into generation metadata for forensics. */
  description: string;
  /**
   * Polish-21.0.13 hotfix: widened to include `'neutral'` for
   * androgynous / voice-cloned timbres that pair cleanly with
   * EITHER a male or a female character. `pickElevenLabsVoicesForBatch`
   * treats a neutral voice as matching any character gender —
   * lets an operator seed the roster with a Polish-22 cloned
   * voice without having to fork the picker.
   *
   * Character gender (from the Claude ad-spec block) stays
   * `'male' | 'female'` via `CharacterVoiceGender` — the Nano
   * Banana image needs a definite gender to render; only the
   * OUTPUT voice can be neutral.
   */
  gender: 'female' | 'male' | 'neutral';
  /** Rough age bracket for ad-test diversity picking. */
  age: 'young' | 'middle_aged';
  /** True on exactly ONE roster entry — the safe-fallback voice. */
  isDefault?: true;
}

/**
 * Legacy alias for the Hedra-era HedraVoiceRosterEntry type.
 * Polish-21.0.4 renamed the roster to ElevenLabs but downstream
 * imports of the old name should continue to compile. New code
 * should import ElevenLabsVoiceRosterEntry directly.
 *
 * @deprecated Use ElevenLabsVoiceRosterEntry.
 */
export type HedraVoiceRosterEntry = ElevenLabsVoiceRosterEntry;

/**
 * Polish-21.0.4 hotfix: ElevenLabs preset voice roster.
 *
 * All UUIDs are public ElevenLabs voice presets — available on
 * every plan, no account-specific voice curation required. Rotate
 * through per-variant for gender × age diversity across a 5-variant
 * batch.
 *
 * Sarah is flagged isDefault=true — most-balanced neutral American
 * timbre that pairs cleanly with the confessional UGC ad copy
 * Polish-19.4.2 preserves verbatim.
 *
 * To use custom / cloned voices, the user pastes UUIDs from their
 * ElevenLabs voice library into a future advanced-form roster
 * override (Polish-22 backlog).
 */
export const ELEVENLABS_VOICE_ROSTER: readonly ElevenLabsVoiceRosterEntry[] = [
  {
    id: 'EXAVITQu4vr4xnSDxMaL',
    label: 'Sarah',
    description: 'Young female, casual conversational American.',
    gender: 'female',
    age: 'young',
    isDefault: true,
  },
  {
    id: 'JBFqnCBsd6RMkjVDRZzb',
    label: 'George',
    description: 'Young male, warm friendly narration.',
    gender: 'male',
    age: 'young',
  },
  {
    id: 'XB0fDUnXU5powFXDhCwa',
    label: 'Charlotte',
    description: 'Middle-aged female, natural conversational.',
    gender: 'female',
    age: 'middle_aged',
  },
  {
    id: 'onwK4e9ZLuTAKqWW03F9',
    label: 'Daniel',
    description: 'Middle-aged male, authoritative narration.',
    gender: 'male',
    age: 'middle_aged',
  },
  {
    id: 'TxGEqnHWrfWFTfGW9XjX',
    label: 'Josh',
    description: 'Young male, deep casual.',
    gender: 'male',
    age: 'young',
  },
];

/**
 * Legacy alias so downstream imports of HEDRA_VOICE_ROSTER don't
 * break during the Polish-21.0.4 migration. New code imports
 * ELEVENLABS_VOICE_ROSTER directly.
 *
 * @deprecated Use ELEVENLABS_VOICE_ROSTER.
 */
export const HEDRA_VOICE_ROSTER: readonly ElevenLabsVoiceRosterEntry[] = ELEVENLABS_VOICE_ROSTER;

/**
 * Returns the entry marked `isDefault: true`. Falls back to the
 * first roster entry if the flag is missing (defensive — the roster
 * is hand-curated so the invariant should hold, but tests pin it).
 */
export function getDefaultElevenLabsVoice(
  roster: readonly ElevenLabsVoiceRosterEntry[] = ELEVENLABS_VOICE_ROSTER,
): ElevenLabsVoiceRosterEntry | undefined {
  if (roster.length === 0) return undefined;
  return roster.find((v) => v.isDefault === true) ?? roster[0];
}

/** @deprecated Use getDefaultElevenLabsVoice. */
export const getDefaultHedraVoice = getDefaultElevenLabsVoice;

/**
 * True when the roster is EMPTY. Kept as a defensive gate on the
 * worker's Hedra + ElevenLabs branch — a future accidental roster
 * wipe would surface a clear error instead of a silent no-op.
 */
export function isElevenLabsVoiceRosterUncurated(
  roster: readonly ElevenLabsVoiceRosterEntry[] = ELEVENLABS_VOICE_ROSTER,
): boolean {
  return roster.length === 0;
}

/** @deprecated Use isElevenLabsVoiceRosterUncurated. */
export const isHedraVoiceRosterUncurated = isElevenLabsVoiceRosterUncurated;

/**
 * Polish-28.1.0 Commit 65: match a persona description to the
 * best-fit voice from the ElevenLabs public roster. Used by the
 * Polish-28 cloned-UGC worker after the IVC-clone pivot — voice is
 * MATCHED (not cloned) so the pipeline works on every ElevenLabs
 * tier including Free (IVC required Starter+).
 *
 * Heuristic: keyword-scan the flattened persona description for
 * gender + age markers, pick the closest roster entry. Falls back
 * to gender-only match, then to the roster default (Sarah).
 *
 * Deliberately simple — 5-voice roster doesn't need audio-feature
 * matching. A future upgrade could pull the ElevenLabs shared
 * voice library (hundreds of voices) and match on audio fingerprint,
 * but that's Polish-28.2+ territory.
 */
export function matchElevenLabsVoiceForPersona(
  personaDescription: string,
  roster: readonly ElevenLabsVoiceRosterEntry[] = ELEVENLABS_VOICE_ROSTER,
): ElevenLabsVoiceRosterEntry {
  if (roster.length === 0) {
    throw new Error(
      'matchElevenLabsVoiceForPersona: empty voice roster — cannot pick. ' +
        'Seed ELEVENLABS_VOICE_ROSTER with at least one entry.',
    );
  }
  const lower = personaDescription.toLowerCase();
  const femaleHit = /\b(woman|female|girl|lady|she\b|her\b|hers|feminine)\b/.test(lower);
  const maleHit = /\b(man|male|guy|boy|dude|he\b|him\b|his\b|masculine)\b/.test(lower);
  const youngHit = /\b(young|youthful|teen|20s|early 30s|twenties|thirties)\b/.test(lower);
  const targetGender: 'female' | 'male' | 'neutral' =
    femaleHit && !maleHit ? 'female' : maleHit && !femaleHit ? 'male' : 'neutral';
  const targetAge: 'young' | 'middle_aged' = youngHit ? 'young' : 'middle_aged';

  // 1. Exact match on gender + age.
  const exact = roster.find((v) => v.gender === targetGender && v.age === targetAge);
  if (exact) return exact;
  // 2. Gender-only match.
  const gender = roster.find((v) => v.gender === targetGender);
  if (gender) return gender;
  // 3. Default.
  return getDefaultElevenLabsVoice(roster) ?? roster[0]!;
}

/**
 * Character gender values the Nano Banana / Hedra character shape
 * emits. Kept narrow so a future roster or picker widening (adding
 * a 'neutral' timbre voice) surfaces via a compile error — TS won't
 * let a caller accidentally pass a raw string like 'nonbinary'.
 *
 * The ElevenLabs roster only carries 'male' | 'female' entries at
 * Polish-21.0.11 launch; `pickElevenLabsVoicesForBatch` matches
 * character gender to voice gender directly. A future 'neutral'
 * character (or 'neutral' voice on the roster) would need to
 * decide the match rule — kept out of scope here.
 */
export type CharacterVoiceGender = 'male' | 'female';

/**
 * Deterministic voice picker: for a batch of N variants, returns N
 * voice entries rotating through the roster (wraps if N > roster
 * length). Same variantCount + roster → same picks, so retries of
 * the same job produce identical output. First entry starts at the
 * `offset` position — used to shuffle across concurrent batches so
 * the same voice doesn't always win variant 0.
 *
 * Polish-21.0.11 hotfix: `characterGender` filters the roster to
 * matching-gender voices BEFORE the offset rotation, so a male
 * character never lands Sarah / Charlotte and a female character
 * never lands George / Daniel / Josh. Defensive fallback: when the
 * roster contains ZERO voices matching characterGender, we return
 * to the full roster — better than crashing the batch if a future
 * roster edit accidentally drops one gender.
 */
export function pickElevenLabsVoicesForBatch(
  variantCount: number,
  offset: number = 0,
  roster: readonly ElevenLabsVoiceRosterEntry[] = ELEVENLABS_VOICE_ROSTER,
  characterGender?: CharacterVoiceGender,
): ElevenLabsVoiceRosterEntry[] {
  if (variantCount <= 0 || roster.length === 0) return [];
  // Polish-21.0.11: filter by gender first.
  // Polish-21.0.13: neutral-gender voices match EITHER character
  // gender (androgynous / voice-cloned timbres). Exact-match rule
  // is `voice.gender === characterGender || voice.gender ===
  // 'neutral'`. Empty-match → fall through to the full roster so
  // the batch still ships (loud-log handled by the caller in the
  // worker). Callers that never want the fall-through can pass
  // undefined characterGender and get the legacy rotation.
  const effectiveRoster =
    characterGender != null
      ? (() => {
          const filtered = roster.filter(
            (v) => v.gender === characterGender || v.gender === 'neutral',
          );
          return filtered.length > 0 ? filtered : roster;
        })()
      : roster;
  const picks: ElevenLabsVoiceRosterEntry[] = [];
  const start =
    ((offset % effectiveRoster.length) + effectiveRoster.length) % effectiveRoster.length;
  for (let i = 0; i < variantCount; i++) {
    picks.push(effectiveRoster[(start + i) % effectiveRoster.length]!);
  }
  return picks;
}

/** @deprecated Use pickElevenLabsVoicesForBatch. */
export const pickHedraVoicesForBatch = pickElevenLabsVoicesForBatch;

/**
 * Deterministic offset for pickElevenLabsVoicesForBatch derived from
 * the job id. Two concurrent batches with different job ids land
 * different voices on variant 0 → more test surface across the
 * operator's rolling batches. Same job id retried → identical
 * picks, so an Inngest retry produces the same output.
 */
export function computeElevenLabsVoiceOffsetForJob(jobId: string): number {
  let hash = 0;
  for (let i = 0; i < jobId.length; i++) {
    hash = (hash * 31 + jobId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** @deprecated Use computeElevenLabsVoiceOffsetForJob. */
export const computeHedraVoiceOffsetForJob = computeElevenLabsVoiceOffsetForJob;

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
