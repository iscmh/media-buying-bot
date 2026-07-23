import 'server-only';
import { describePipeline, pipelineFromString } from '@mbb/shared';
import { inngest } from '@mbb/jobs';

/**
 * Single chokepoint for sending generation-job events from the web. Static
 * jobs go straight to `generation/static.requested`; UGC jobs first hit
 * `generation/analyze.requested` (Gemini Vision deconstruction in Phase
 * 3b; mock JSON in 3a) and the analyzer fans out to
 * `generation/ugc.requested` when it completes.
 *
 * Polish-25.3 Commit 18b: routing extended to honor `pickedPipeline`.
 * When the caller passes a pipeline that maps to a static-content
 * descriptor (e.g. `static_openai_image` → `generation/static-openai
 * .requested`), we send directly to that worker's event instead of
 * the generic static/analyze fan-out. UGC pipelines still go through
 * analyze-concept, which resolves the picked pipeline from job.metadata
 * and dispatches to the right worker.
 */
export async function sendGenerationJobEvent(input: {
  contentType: 'static' | 'ugc';
  jobId: string;
  userId: string;
  mode: 'mock' | 'live';
  /**
   * The pipeline the caller picked (from the descriptor table).
   * Static pipelines dispatch to their descriptor.workerEvent
   * directly; UGC pipelines let analyze-concept route.
   */
  pickedPipeline?: string | null;
}): Promise<void> {
  const eventName = resolveEventName(input.contentType, input.pickedPipeline ?? null);
  await inngest.send({
    name: eventName,
    data: {
      jobId: input.jobId,
      userId: input.userId,
      mode: input.mode,
    },
  });
}

function resolveEventName(
  contentType: 'static' | 'ugc',
  pickedPipeline: string | null,
):
  | 'generation/static.requested'
  | 'generation/analyze.requested'
  | 'generation/static-openai.requested' {
  // Static path: check the descriptor first so new static workers
  // (like Polish-25.3 Commit 18b's OpenAI worker) route directly
  // without touching this switch. Fallback keeps the legacy
  // Gemini/nano-banana path alive at `generation/static.requested`.
  if (contentType === 'static') {
    const pipeline = pipelineFromString(pickedPipeline);
    if (pipeline) {
      const workerEvent = describePipeline(pipeline).workerEvent;
      if (workerEvent === 'generation/static-openai.requested') {
        return 'generation/static-openai.requested';
      }
    }
    return 'generation/static.requested';
  }
  // UGC path always goes through analyze-concept — it resolves
  // pickedPipeline via the descriptor and dispatches to the right
  // downstream worker.
  return 'generation/analyze.requested';
}

/**
 * Phase 4a: dispatch the Meta auto-launch job for an approved generation.
 * Caller (jobs/[id]) must have already enforced the daily launch cap
 * server-side; the Inngest worker re-checks defense-in-depth.
 */
export async function sendMetaLaunchEvent(input: {
  userId: string;
  generationJobId: string;
  mode?: 'mock' | 'live';
  pageId?: string;
  offerUrl?: string;
  targetingCountries?: string[];
  ageMin?: number;
  ageMax?: number;
  perAdBudgetUsd?: number;
}): Promise<void> {
  await inngest.send({
    name: 'meta/launch.requested',
    data: {
      userId: input.userId,
      generationJobId: input.generationJobId,
      mode: input.mode,
      pageId: input.pageId,
      offerUrl: input.offerUrl,
      targetingCountries: input.targetingCountries,
      ageMin: input.ageMin,
      ageMax: input.ageMax,
      perAdBudgetUsd: input.perAdBudgetUsd,
    },
  });
}
