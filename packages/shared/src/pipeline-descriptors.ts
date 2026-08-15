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
  providerChoice: 'heygen' | 'openai' | 'gemini' | 'makeugc' | 'clone_ugc';
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
    | 'generation/polish25-makeugc.requested'
    // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad worker.
    | 'generation/static-openai.requested'
    // Polish-26 Commit 61: HeyGen v3 managed Instant UGC worker.
    | 'generation/polish26-heygen.requested'
    // Polish-28.0.0 Commit 64: BYOK-only cloned-UGC pipeline
    // (Nano Banana Pro + ElevenLabs IVC + HeyGen Avatar IV).
    | 'generation/polish28-clone-ugc.requested';
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
    // Polish-28.0.0 Commit 64: ElevenLabs BYOK — required for the
    // Instant Voice Clone + TTS-with-cloned-voice steps.
    | 'elevenlabs'
    // Polish-28.0.5 Commit 64.5: Replicate BYOK — required for the
    // ffmpeg audio-extract + frame-extract steps (pivoted off local
    // ffmpeg after Vercel Hobby's 50MB function limit rejected the
    // @ffmpeg-installer binary bundling).
    | 'replicate'
  >;
}

const DESCRIPTORS: Record<PipelineType, PipelineDescriptor> = {
  heygen_avatar_talking_head: {
    pipeline: 'heygen_avatar_talking_head',
    label: 'Avatar talking head',
    providerChoice: 'heygen',
    format: 'avatar_talking_head',
    workerEvent: 'generation/ugc.requested',
    requiredProviders: ['heygen'],
  },
  sora_2_single_shot: {
    pipeline: 'sora_2_single_shot',
    label: 'Single-shot video',
    providerChoice: 'openai',
    format: 'sora_single_shot',
    workerEvent: 'generation/sora.requested',
    requiredProviders: ['openai'],
  },
  nano_banana_static_image: {
    pipeline: 'nano_banana_static_image',
    label: 'Static image',
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
    label: 'Higgsfield UGC ad',
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
    label: 'Instant UGC ad',
    providerChoice: 'makeugc',
    format: 'polish25_makeugc',
    workerEvent: 'generation/polish25-makeugc.requested',
    requiredProviders: ['claude', 'gemini', 'makeugc'],
  },
  // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad — user
  // uploads a winning static ad, Claude rewrites the overlay copy
  // per variant, OpenAI /v1/images/edits produces the corresponding
  // image variation anchored on the reference. Quality tier drives
  // per-image cost (low $0.02 / medium $0.05 / high $0.20).
  static_openai_image: {
    pipeline: 'static_openai_image',
    label: 'Static ad',
    providerChoice: 'openai',
    format: 'static_openai_image',
    workerEvent: 'generation/static-openai.requested',
    requiredProviders: ['claude', 'openai'],
  },
  // Polish-26 Commit 61: HeyGen v3 PAYG managed Instant UGC —
  // successor to polish25_makeugc as the primary managed backend.
  // Avatar V engine bills per-second ($1.50 per 30-sec video at
  // Avatar V $0.05/sec). Character consistency via HeyGen's 500+
  // pre-cast avatar library, enriched with Gemini vision analysis
  // in heygen_avatar_index for persona-driven matching. Requires
  // Claude for script condensing + Gemini for source vision +
  // HeyGen for the video render (platform-managed via
  // HEYGEN_MANAGED_KEY, BYOK fallback for dev).
  polish26_heygen: {
    pipeline: 'polish26_heygen',
    label: 'Instant UGC ad (HeyGen)',
    providerChoice: 'heygen',
    format: 'polish26_heygen',
    workerEvent: 'generation/polish26-heygen.requested',
    requiredProviders: ['claude', 'gemini', 'heygen'],
  },
  // Polish-28.0.0 Commit 64: BYOK-only cloned-UGC pipeline. Source-
  // cloned character (Nano Banana Pro) + source-cloned voice
  // (ElevenLabs IVC) + HeyGen Avatar IV image-to-video lip-sync.
  // Platform variable cost = $0; user pays direct via their 4 BYOK
  // keys (Claude, Gemini, ElevenLabs, HeyGen). Output locked to
  // 9:16 vertical for Meta Reels / TikTok / IG Reels.
  polish28_clone_ugc: {
    pipeline: 'polish28_clone_ugc',
    label: 'Instant UGC (Cloned)',
    providerChoice: 'clone_ugc',
    format: 'polish28_clone_ugc',
    workerEvent: 'generation/polish28-clone-ugc.requested',
    // Polish-28.2.0 Commit 73: dropped 'elevenlabs' — HeyGen native
    // TTS (script + voice_id) replaced external audio path after
    // audio_url + audio_asset_id both failed silently in prod. 4-BYOK.
    // Kept: claude (script condense), gemini (Nano Banana character
    // clone), heygen (voice list + Avatar IV lip-sync + TTS),
    // replicate (fofr/toolkit frame extract).
    requiredProviders: ['claude', 'gemini', 'heygen', 'replicate'],
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

/**
 * Polish-27.0.0 Commit 63: this list narrowed to REGISTERED pipelines
 * only (i.e. those whose workerEvent appears in
 * REGISTERED_GENERATION_WORKER_EVENTS). The Polish-28 UGC rebuild is
 * imminent; the four legacy UGC pipelines (polish23_higgsfield_veo_lite,
 * polish25_makeugc, polish26_heygen, heygen_avatar_talking_head) had
 * their workers unregistered and are not dispatchable, so the dispatch-
 * coverage tripwire (packages/jobs/tests/dispatch-coverage.test.ts)
 * would fail if they stayed in ALL_PIPELINES.
 *
 * DESCRIPTORS (above) still carries the full type — PipelineType stays
 * complete so downstream forensics (log parsers reading historical
 * generation_jobs.picked_pipeline) still round-trip cleanly. This is a
 * narrowing of "what dispatch currently supports", not a schema
 * removal.
 *
 * Rollback: add the removed entries back here and re-register their
 * workers in packages/jobs/src/functions/index.ts.
 */
export const ALL_PIPELINES: PipelineType[] = [
  // heygen_avatar_talking_head is legacy Polish-4 UGC, still dispatched
  // through generateUgcVariants (event 'generation/ugc.requested') which
  // remains registered. Not surfaced on the generate form post-Polish-27
  // Commit 63 nuke, but the API + coverage test still see it.
  'heygen_avatar_talking_head',
  'sora_2_single_shot',
  'nano_banana_static_image',
  // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad pipeline —
  // the SOLE user-facing generation pipeline post-Polish-27 Commit 63
  // nuke. Users pick Static ad from the generate form; the "Custom UGC"
  // slot shows a "Coming soon" placeholder until Polish-28 lands.
  'static_openai_image',
  // Polish-28.0.0 Commit 64: BYOK-only cloned-UGC pipeline. Worker
  // is registered in packages/jobs/src/functions/index.ts; user-facing
  // via the "Instant UGC (Cloned)" card on the generate form.
  'polish28_clone_ugc',
];
