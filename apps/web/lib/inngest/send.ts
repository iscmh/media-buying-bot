import 'server-only';
import { inngest } from '@mbb/jobs';

/**
 * Single chokepoint for sending generation-job events from the web. Static
 * jobs go straight to `generation/static.requested`; UGC jobs first hit
 * `generation/analyze.requested` (Gemini Vision deconstruction in Phase
 * 3b; mock JSON in 3a) and the analyzer fans out to
 * `generation/ugc.requested` when it completes.
 *
 * Phase 3a sends mock-mode events; Phase 3b will pass through the same
 * shape with `mode: 'live'` once real API calls are wired.
 */
export async function sendGenerationJobEvent(input: {
  contentType: 'static' | 'ugc';
  jobId: string;
  userId: string;
  mode: 'mock' | 'live';
}): Promise<void> {
  const eventName =
    input.contentType === 'static' ? 'generation/static.requested' : 'generation/analyze.requested';
  await inngest.send({
    name: eventName,
    data: {
      jobId: input.jobId,
      userId: input.userId,
      mode: input.mode,
    },
  });
}
