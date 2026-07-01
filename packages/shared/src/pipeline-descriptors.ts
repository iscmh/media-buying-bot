import type { PipelineType } from './cost-estimation';

/**
 * Polish-9.2: canonical mapping from a Polish-6 PipelineType to the
 * job-row columns (providerChoice, format), the Inngest event name the
 * matching worker listens for, and a human label.
 *
 * Pure — used by the web app on submit AND by analyze-concept on
 * fan-out so the routing is consistent on both sides of the queue.
 */
export interface PipelineDescriptor {
  pipeline: PipelineType;
  /** label rendered in the form + job-review header */
  label: string;
  /** providerChoice column written on generation_jobs */
  providerChoice: 'heygen' | 'kling' | 'openai' | 'gemini';
  /** format column written on generation_jobs */
  format: string;
  /**
   * Inngest event name the worker listens for. analyze-concept can
   * skip this lookup when picked_pipeline is null on the job row and
   * fall back to legacy format-based routing.
   */
  workerEvent:
    | 'generation/ugc.requested'
    | 'generation/kling-multi-clip.requested'
    | 'generation/kling-3-omni-multi-segment.requested'
    | 'generation/kie-omni-flash-native.requested'
    | 'generation/kie-kling-avatar-v2.requested'
    | 'generation/sora.requested'
    | 'generation/nano-banana.requested';
  /** providers the user MUST have connected for this pipeline to work. */
  requiredProviders: Array<
    'heygen' | 'kling' | 'openai' | 'gemini' | 'elevenlabs' | 'claude' | 'kie_ai'
  >;
  /**
   * Polish-19: marks the pipeline that callers should pick when the
   * user hasn't expressed a preference. Exactly one descriptor must
   * carry `isDefault: true`; defaultPipeline() asserts this.
   */
  isDefault?: boolean;
}

const DESCRIPTORS: Record<PipelineType, PipelineDescriptor> = {
  heygen_avatar_talking_head: {
    pipeline: 'heygen_avatar_talking_head',
    label: 'Avatar talking head (HeyGen)',
    providerChoice: 'heygen',
    format: 'avatar_talking_head',
    workerEvent: 'generation/ugc.requested',
    requiredProviders: ['heygen'],
  },
  sora_2_single_shot: {
    pipeline: 'sora_2_single_shot',
    label: 'Single shot (Sora 2)',
    providerChoice: 'openai',
    format: 'sora_single_shot',
    workerEvent: 'generation/sora.requested',
    requiredProviders: ['openai'],
  },
  kling_3_multi_clip_native_lipsync: {
    pipeline: 'kling_3_multi_clip_native_lipsync',
    label: 'UGC ad (Kling multi-clip with reference chain)',
    providerChoice: 'kling',
    format: 'kling_3_multi_clip',
    workerEvent: 'generation/kling-multi-clip.requested',
    requiredProviders: ['kling'],
  },
  kling_3_omni_multi_segment: {
    pipeline: 'kling_3_omni_multi_segment',
    label: 'Experimental: Kling 3.0 Omni 30s (mixed quality)',
    providerChoice: 'kling',
    format: 'kling_3_omni_multi_segment',
    workerEvent: 'generation/kling-3-omni-multi-segment.requested',
    requiredProviders: ['kling', 'gemini'],
  },
  kie_omni_flash_native: {
    pipeline: 'kie_omni_flash_native',
    label: 'UGC ad (Gemini Omni Flash, experimental, scales to source length)',
    providerChoice: 'kling',
    format: 'kie_omni_flash_native',
    workerEvent: 'generation/kie-omni-flash-native.requested',
    requiredProviders: ['claude', 'gemini', 'kie_ai'],
    // Polish-19: demoted from default in favor of kie_kling_avatar_v2_standard
    // (single-call lipsync, ~25% lower per-variant cost). Stays available as
    // an advanced-only pipeline for sources where multi-segment generation
    // is genuinely a better fit.
  },
  // Polish-19 → Polish-20: Kling Avatar v2 (image + audio + lipsync).
  // Retained through Polish-20 Commit 3 as the legacy default —
  // Commit 4 deletes this and every other legacy pipeline once the
  // unified generate-video-variant worker is fully proven. The form's
  // `defaultPipeline()` call resolves here until then.
  kie_kling_avatar_v2_standard: {
    pipeline: 'kie_kling_avatar_v2_standard',
    label: 'UGC ad (Kling Avatar v2, image + lipsync — legacy)',
    providerChoice: 'kling',
    format: 'kie_kling_avatar_v2_standard',
    workerEvent: 'generation/kie-kling-avatar-v2.requested',
    requiredProviders: ['claude', 'gemini', 'kie_ai', 'elevenlabs'],
    isDefault: true,
  },
  nano_banana_static_image: {
    pipeline: 'nano_banana_static_image',
    label: 'Static image (Nano Banana)',
    providerChoice: 'gemini',
    format: 'nano_banana_static_image',
    workerEvent: 'generation/nano-banana.requested',
    requiredProviders: ['gemini'],
  },
};

export function describePipeline(pipeline: PipelineType): PipelineDescriptor {
  return DESCRIPTORS[pipeline];
}

export function pipelineFromString(value: string | null | undefined): PipelineType | null {
  if (!value) return null;
  return value in DESCRIPTORS ? (value as PipelineType) : null;
}

/**
 * Polish-19: the pipeline picked when the user hasn't expressed a
 * preference. Exactly one descriptor in DESCRIPTORS carries
 * `isDefault: true` — enforced at module load so a future drift in
 * the table surfaces loudly on the next boot, not silently at runtime.
 */
export function defaultPipeline(): PipelineType {
  const defaults = Object.values(DESCRIPTORS).filter((d) => d.isDefault);
  if (defaults.length !== 1) {
    throw new Error(
      `pipeline-descriptors: expected exactly 1 default pipeline, found ${defaults.length}`,
    );
  }
  return defaults[0]!.pipeline;
}

export const ALL_PIPELINES: PipelineType[] = [
  'heygen_avatar_talking_head',
  'sora_2_single_shot',
  'kling_3_omni_multi_segment',
  'kling_3_multi_clip_native_lipsync',
  'kie_omni_flash_native',
  'kie_kling_avatar_v2_standard',
  'nano_banana_static_image',
];
