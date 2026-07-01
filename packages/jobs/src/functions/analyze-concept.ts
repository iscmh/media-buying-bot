import { eq } from 'drizzle-orm';
import { callGeminiVision } from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { UGC_DECONSTRUCTOR_SYSTEM_PROMPT, describePipeline, pipelineFromString } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { downloadAsBase64 } from '../lib/storage';

/**
 * Phase 3b: real UGC concept analyzer. Replaces the Phase 3a mock that
 * sleeps 3s and stuffs placeholder JSON onto generation_jobs.metadata.
 *
 * mode='mock' path is preserved so dev/QA can still walk the flow without
 * burning Gemini credits — falls back to the same placeholder JSON.
 *
 * mode='live' path:
 *   1. mark job processing
 *   2. (decrypt + fetch + call Gemini Vision) inside ONE step.run so the
 *      base64 video never crosses Inngest's step-output serialization
 *      (Inngest persists step I/O; serializing 20 MB base64 would blow
 *      its size limits).
 *   3. store parsed JSON on generation_jobs.metadata, accumulate cost
 *   4. fan out to generation/ugc.requested (which then runs the variant
 *      generator)
 *
 * On failure: mark job failed with a sanitized message, don't fan out.
 *
 * Concept video size cap: 2 GB — matches Gemini Files API's per-file
 * ceiling (Phase 3h). callGeminiVision routes inline ≤ 20 MB and
 * Files API for the rest; this cap is defense-in-depth so we don't
 * burn an Inngest step on a file that the downstream call would
 * reject anyway.
 */

const GEMINI_VISION_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MOCK_METADATA = {
  _mock: true,
  analysis_version: 'phase-3a-stub',
  hooks: [
    { time_seconds: [0, 3], description: 'Mock hook 1 — pattern interrupt' },
    { time_seconds: [3, 6], description: 'Mock hook 2 — direct address' },
  ],
  proof_points: ['Mock proof 1', 'Mock proof 2'],
  cta: 'Mock CTA copy',
};

export const analyzeConcept = inngest.createFunction(
  {
    id: 'analyze-concept',
    name: 'Analyze concept (UGC vision)',
    retries: 1,
  },
  { event: 'generation/analyze.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;

    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
    });

    if (mode === 'mock') {
      await step.sleep('mock-vision-latency', '3s');
      await step.run('store-mock-analysis', async () => {
        // Polish-19.3.1 hotfix: MERGE with existing metadata instead
        // of overwriting. Pre-19.3.1 destructively replaced the
        // metadata blob — erasing the action handler's
        // source_duration_seconds + voice_id + model_id fields.
        // Downstream workers then read metadata, found no length /
        // model, fell back to defaults, and silently produced
        // wrong-length output.
        //
        // Spread order: vision-at-root first (Polish-12 back-compat),
        // form-written fields override (user-picked beats AI-estimated
        // when names collide). Vision is also nested under `.analysis`
        // for the Polish-19.3.1 fallback-chain lookup.
        const db = getDb();
        const existing = await db.query.generationJobs.findFirst({
          where: eq(schema.generationJobs.id, jobId),
          columns: { metadata: true },
        });
        const prior = (existing?.metadata as Record<string, unknown> | null) ?? {};
        await db
          .update(schema.generationJobs)
          .set({
            metadata: {
              ...MOCK_METADATA,
              ...prior,
              analysis: MOCK_METADATA,
              analyzed_at: new Date().toISOString(),
            },
          })
          .where(eq(schema.generationJobs.id, jobId));
      });
      await step.run('audit-mock', async () => {
        await logAuditEvent({
          userId,
          eventType: 'concept_analyzed',
          eventData: { job_id: jobId, mode, mock: true },
        });
      });
      // Polish-4: split fan-out by creative format. Cinematic voiceover
      // (Kling + ElevenLabs) gets its own worker; avatar talking head
      // (HeyGen) keeps the legacy event. Format is set at job creation
      // time on the form; defaults to avatar_talking_head.
      const mockEvent = await loadJobRoutingEvent(jobId);
      await step.sendEvent(`fan-out-mock-${mockEvent.replace(/\W/g, '_')}`, {
        name: mockEvent,
        data: { jobId, userId, mode },
      });
      return { jobId, mode, path: 'mock' };
    }

    // ----- Live path -----

    const visionResult = await step.run('vision-call', async () => {
      // Decrypt key + read video + call Gemini all in one step. Returning
      // the parsed JSON keeps the step output small (no base64 across
      // boundaries).
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['gemini']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          return { ok: false as const, error: err.message, costUsd: 0, latencyMs: 0 };
        }
        throw err;
      }
      const apiKey = keys.gemini!;

      // Look up the concept's storage path from this job's first concept_id.
      const db = getDb();
      const job = await db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { conceptIds: true },
      });
      const conceptId = job?.conceptIds?.[0];
      if (!conceptId) {
        return {
          ok: false as const,
          error: 'Job has no concept_id',
          costUsd: 0,
          latencyMs: 0,
        };
      }
      const concept = await db.query.concepts.findFirst({
        where: eq(schema.concepts.id, conceptId),
        columns: { fileUrl: true },
      });
      if (!concept?.fileUrl) {
        return {
          ok: false as const,
          error: 'Concept missing file_url',
          costUsd: 0,
          latencyMs: 0,
        };
      }

      let video;
      try {
        video = await downloadAsBase64({
          bucket: 'concepts',
          path: concept.fileUrl,
          maxBytes: GEMINI_VISION_MAX_BYTES,
        });
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
          costUsd: 0,
          latencyMs: 0,
        };
      }

      const vision = await callGeminiVision({
        userId,
        apiKey,
        systemPrompt: UGC_DECONSTRUCTOR_SYSTEM_PROMPT,
        videoBase64: video.base64,
        videoMimeType: video.mimeType,
        generationJobId: jobId,
      });

      if (!vision.ok) {
        return {
          ok: false as const,
          error: vision.errorMessage ?? 'Gemini Vision call failed',
          costUsd: vision.costUsd,
          latencyMs: vision.latencyMs,
        };
      }

      return {
        ok: true as const,
        analysis: vision.json as Record<string, unknown>,
        costUsd: vision.costUsd,
        latencyMs: vision.latencyMs,
      };
    });

    if (!visionResult.ok) {
      await step.run('mark-failed', async () => {
        const db = getDb();
        await db
          .update(schema.generationJobs)
          .set({
            status: 'failed',
            errorMessage: visionResult.error,
          })
          .where(eq(schema.generationJobs.id, jobId));
        await logAuditEvent({
          userId,
          eventType: 'concept_analyzed',
          eventData: {
            job_id: jobId,
            mode,
            mock: false,
            ok: false,
            error: visionResult.error,
            cost_usd: visionResult.costUsd,
          },
        });
      });
      return { jobId, mode, path: 'live', ok: false };
    }

    await step.run('store-analysis', async () => {
      // Polish-19.3.1 hotfix: merge instead of overwrite. See the
      // mock-path comment for the bug history. Spread order: vision
      // at root (Polish-12 back-compat), form fields override
      // (user-picked beats AI-estimated). Vision is also nested
      // under `.analysis` so the video-variant worker's fallback
      // chain can read job.metadata.analysis.video_duration_seconds
      // without worrying about root-level shape drift.
      const db = getDb();
      const existing = await db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { metadata: true },
      });
      const prior = (existing?.metadata as Record<string, unknown> | null) ?? {};
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...visionResult.analysis,
            ...prior,
            analysis: visionResult.analysis,
            _live: true,
            analyzed_at: new Date().toISOString(),
          },
          actualCostUsd: visionResult.costUsd.toFixed(4),
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    await step.run('audit-live', async () => {
      await logAuditEvent({
        userId,
        eventType: 'concept_analyzed',
        eventData: {
          job_id: jobId,
          mode,
          mock: false,
          ok: true,
          cost_usd: visionResult.costUsd,
          latency_ms: visionResult.latencyMs,
        },
      });
    });

    // Polish-4: split fan-out by creative format. See mock-path comment
    // above for the routing rationale.
    const liveEvent = await loadJobRoutingEvent(jobId);
    await step.sendEvent(`fan-out-live-${liveEvent.replace(/\W/g, '_')}`, {
      name: liveEvent,
      data: { jobId, userId, mode },
    });

    return { jobId, mode, path: 'live', ok: true, costUsd: visionResult.costUsd };
  },
);

/**
 * Polish-9.2: read the Polish-6 picked_pipeline + Polish-4 format columns
 * and return the canonical worker event name to dispatch. Precedence:
 *   1. picked_pipeline set → use the descriptor's workerEvent.
 *   2. format = 'cinematic_voiceover' → legacy Polish-4 cinematic worker.
 *   3. otherwise → default UGC (HeyGen) worker.
 *
 * Returns 'generation/ugc.requested' on any error so the job doesn't
 * stall — the default worker exists for every user.
 */
async function loadJobRoutingEvent(
  jobId: string,
): Promise<
  | 'generation/ugc.requested'
  | 'generation/sora.requested'
  | 'generation/nano-banana.requested'
  | 'generation/video-variant.requested'
> {
  try {
    const db = getDb();
    const row = await db.query.generationJobs.findFirst({
      where: eq(schema.generationJobs.id, jobId),
      columns: { format: true, pickedPipeline: true, metadata: true },
    });
    // Polish-20 Commit 2: descriptor-driven routing wins over the
    // legacy pickedPipeline field. When metadata.model_id is set the
    // form used the new picker → dispatch to the unified
    // generate-video-variant worker, which reads model_id + provider_id
    // out of metadata to look up the ModelProviderConfig.
    const metadataObj = (row?.metadata ?? null) as Record<string, unknown> | null;
    const modelIdFromMetadata =
      metadataObj && typeof metadataObj['model_id'] === 'string'
        ? (metadataObj['model_id'] as string)
        : null;
    if (modelIdFromMetadata) {
      console.log(
        `[analyze-concept] job ${jobId} dispatch: model_id=${modelIdFromMetadata} → ` +
          `workerEvent=generation/video-variant.requested (Polish-20 unified worker)`,
      );
      return 'generation/video-variant.requested';
    }
    const pipeline = pipelineFromString(row?.pickedPipeline);
    if (pipeline) {
      const workerEvent = describePipeline(pipeline).workerEvent;
      // Polish-19.2.1: loud dispatch log. Pre-19.2.1 the dispatch
      // decision was silent — when a worker silently failed to pick
      // up its event, there was no log line showing what
      // analyze-concept actually sent. With this log, a stuck job's
      // dispatch decision is visible in Inngest output alongside
      // the analyze step's other audit lines.
      console.log(
        `[analyze-concept] job ${jobId} dispatch: pickedPipeline=${row?.pickedPipeline} → ` +
          `workerEvent=${workerEvent} (resolved from descriptor)`,
      );
      return workerEvent;
    }
    console.log(
      `[analyze-concept] job ${jobId} dispatch: no pickedPipeline + format=${row?.format ?? 'null'} → ` +
        `workerEvent=generation/ugc.requested (default UGC fallback)`,
    );
    return 'generation/ugc.requested';
  } catch (err) {
    console.log(
      `[analyze-concept] job ${jobId} dispatch error: ${err instanceof Error ? err.message : String(err)}; ` +
        `falling back to generation/ugc.requested`,
    );
    return 'generation/ugc.requested';
  }
}
