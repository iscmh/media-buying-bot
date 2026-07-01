import type { PipelineType } from './cost-estimation';

/**
 * Polish-9.2 → Polish-20 Commit 4: canonical mapping from PipelineType
 * to the job-row columns (providerChoice, format), the Inngest event
 * name the matching worker listens for, and a human label.
 *
 * After Commit 4 the enum covers only three surviving legacy paths:
 *   - HeyGen avatar talking head (`generation/ugc.requested`)
 *   - Sora 2 single shot         (`generation/sora.requested`)
 *   - Nano Banana static image   (`generation/nano-banana.requested`)
 *
 * The Polish-20 UGC video flow does NOT go through this table — it's
 * driven by the ModelProviderConfig descriptor in video-models.ts
 * and dispatched to `generation/video-variant.requested`. No
 * PipelineType member represents the new flow; there is no
 * pipeline-level default anymore (the form requires the user to pick
 * a model via the mandatory picker), so `defaultPipeline()` throws
 * when called.
 */
export interface PipelineDescriptor {
  pipeline: PipelineType;
  /** label rendered in the form + job-review header */
  label: string;
  /** providerChoice column written on generation_jobs */
  providerChoice: 'heygen' | 'openai' | 'gemini';
  /** format column written on generation_jobs */
  format: string;
  /**
   * Inngest event name the worker listens for. analyze-concept can
   * skip this lookup when picked_pipeline is null on the job row and
   * fall back to legacy format-based routing.
   */
  workerEvent:
    | 'generation/ugc.requested'
    | 'generation/sora.requested'
    | 'generation/nano-banana.requested';
  /** providers the user MUST have connected for this pipeline to work. */
  requiredProviders: Array<'heygen' | 'openai' | 'gemini' | 'claude' | 'kie_ai'>;
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
 * Polish-20 Commit 4: NO PIPELINE-LEVEL DEFAULT.
 *
 * The new UGC video flow doesn't use PipelineType — it routes through
 * ModelProviderConfig via the simplified form's mandatory model
 * picker. The remaining PipelineType members (heygen / sora / nano-
 * banana) each serve a distinct concept type (avatar / video / static
 * image) and the caller always picks one explicitly. Calling
 * `defaultPipeline()` throws so a caller who forgot to migrate off
 * this signal surfaces the drift immediately.
 */
export function defaultPipeline(): PipelineType {
  throw new Error(
    'defaultPipeline() has no default after Polish-20 Commit 4. UGC video uses ' +
      'ModelProviderConfig (see @mbb/shared video-models.ts) via the simplified ' +
      "form's mandatory model picker; non-UGC callers must pick a specific " +
      'PipelineType explicitly (heygen / sora / nano-banana).',
  );
}

export const ALL_PIPELINES: PipelineType[] = [
  'heygen_avatar_talking_head',
  'sora_2_single_shot',
  'nano_banana_static_image',
];
