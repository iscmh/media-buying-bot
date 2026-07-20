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
  providerChoice: 'heygen' | 'openai' | 'gemini' | 'makeugc';
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
    | 'generation/nano-banana.requested'
    // Polish-23 Commit 1: reserved for the Polish-23 Commit-3
    // kie.ai Veo 3.1 Lite + Higgsfield Soul worker. Named here so
    // the descriptor + estimator + form pickers type-check even
    // though the worker file doesn't land until Commit 3.
    | 'generation/polish23-veo-lite.requested'
    // Polish-25 Commit 2: MakeUGC pre-cast avatar UGC ad worker.
    | 'generation/polish25-makeugc.requested';
  /** providers the user MUST have connected for this pipeline to work. */
  requiredProviders: Array<
    | 'heygen'
    | 'openai'
    | 'gemini'
    | 'claude'
    | 'kie_ai'
    // Polish-23 Commit 1: WaveSpeedAI-hosted Higgsfield Soul.
    | 'wavespeed_ai'
    // Polish-25 Commit 2: MakeUGC pre-cast avatar renderer.
    | 'makeugc'
  >;
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
  // Polish-23 Commit 1: reserved descriptor for the kie.ai Veo
  // 3.1 Lite + Higgsfield Soul pipeline that Commit 3 wires. The
  // form picker doesn't surface this yet (worker isn't registered);
  // the entry is here so estimator lookups + tests share the
  // shape from day one.
  polish23_higgsfield_veo_lite: {
    pipeline: 'polish23_higgsfield_veo_lite',
    label: 'UGC ad (Higgsfield Soul + kie.ai Veo 3.1 Lite — Polish-23)',
    providerChoice: 'gemini',
    format: 'polish23_higgsfield_veo_lite',
    workerEvent: 'generation/polish23-veo-lite.requested',
    requiredProviders: ['claude', 'gemini', 'kie_ai', 'wavespeed_ai'],
  },
  // Polish-25 Commit 2: MakeUGC pre-cast avatar UGC ad. Single
  // video output at ~$0.05 per 60s (Starter tier). Character
  // consistency guaranteed via pre-cast avatar library. Requires
  // Claude for script condensing + MakeUGC for the video render.
  polish25_makeugc: {
    pipeline: 'polish25_makeugc',
    label: 'UGC ad (MakeUGC pre-cast avatar — Polish-25)',
    providerChoice: 'makeugc',
    format: 'polish25_makeugc',
    workerEvent: 'generation/polish25-makeugc.requested',
    requiredProviders: ['claude', 'gemini', 'makeugc'],
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
  // Polish-23 Commit 1: reserved; not surfaced in the form until
  // Commit 3 wires the worker.
  'polish23_higgsfield_veo_lite',
  // Polish-25 Commit 2: MakeUGC pre-cast avatar UGC ad — primary
  // pipeline going forward (single video output @ ~$0.05).
  'polish25_makeugc',
];
