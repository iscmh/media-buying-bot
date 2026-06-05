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
    | 'generation/sora.requested'
    | 'generation/nano-banana.requested';
  /** providers the user MUST have connected for this pipeline to work. */
  requiredProviders: Array<'heygen' | 'kling' | 'openai' | 'gemini' | 'elevenlabs'>;
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
    label: '16-clip lip-sync (Kling 3.0)',
    providerChoice: 'kling',
    format: 'kling_3_multi_clip',
    workerEvent: 'generation/kling-multi-clip.requested',
    requiredProviders: ['kling'],
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

export const ALL_PIPELINES: PipelineType[] = [
  'heygen_avatar_talking_head',
  'sora_2_single_shot',
  'kling_3_multi_clip_native_lipsync',
  'nano_banana_static_image',
];
