import { eq } from 'drizzle-orm';
import { callGeminiVision } from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import {
  POLISH23_VISION_SYSTEM_PROMPT,
  UGC_DECONSTRUCTOR_SYSTEM_PROMPT,
  describePipeline,
  pipelineFromString,
} from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
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
    onFailure: logInngestFailure,
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

      // Polish-23 Commit 3.0.19: pick vision prompt based on the
      // job's picked_pipeline. Polish-23 jobs get the extended
      // schema with structured persona / setting / emotional_arc
      // / hook / niche fields. Everything else keeps the operator-
      // tuned Polish-21 UGC_DECONSTRUCTOR prompt untouched.
      const jobPipelineRow = await db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { pickedPipeline: true },
      });
      // Polish-25 Commit 2: Polish-25 (MakeUGC) ALSO needs the extended
      // Polish-23 vision schema (persona + setting_details + emotional_arc
      // + hook + niche) since the Polish-25 Claude condenser reads the
      // same shape. Treat both pipelines as "needs Polish-23 vision".
      const picked = jobPipelineRow?.pickedPipeline ?? null;
      const usesPolish23Vision =
        picked === 'polish23_higgsfield_veo_lite' || picked === 'polish25_makeugc';
      const visionSystemPrompt = usesPolish23Vision
        ? POLISH23_VISION_SYSTEM_PROMPT
        : UGC_DECONSTRUCTOR_SYSTEM_PROMPT;
      console.log(
        `[analyze-concept] job ${jobId} using ${
          usesPolish23Vision ? 'POLISH23_VISION_SYSTEM_PROMPT' : 'UGC_DECONSTRUCTOR_SYSTEM_PROMPT'
        } (picked_pipeline=${picked ?? 'null'})`,
      );

      const vision = await callGeminiVision({
        userId,
        apiKey,
        systemPrompt: visionSystemPrompt,
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
        conceptId,
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
      // Polish-19.3.1 → Polish-20.0.3 hotfix: merge instead of
      // overwrite, AND unwrap Gemini's inner `analysis` field before
      // nesting. Pre-20.0.3 wrote `analysis: visionResult.analysis`
      // where visionResult.analysis was the ENTIRE Gemini response
      // ({analysis: {...}, draft_prompt: '...'}) — that produced
      // metadata.analysis.analysis.subject double-nesting AND leaked
      // the Sora-era draft_prompt into the video-variant worker's
      // Claude context, making it copy the bracketed section format
      // instead of writing yapper prose.
      //
      // Now we extract the vision's INNER `analysis` object so
      // metadata.analysis.script_transcription etc. land at the
      // shape resolveAutoVideoDuration + extractSourceScriptVerbatim
      // expect. draft_prompt is retained at the root for legacy
      // callers that read it, but it's NOT copied into the nested
      // analysis object (see runClaudeAdSpec's source_analysis
      // stripping for the read-side of this cleanup).
      const innerAnalysis = extractInnerVisionAnalysis(visionResult.analysis);
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
            analysis: innerAnalysis,
            _live: true,
            analyzed_at: new Date().toISOString(),
          },
          actualCostUsd: visionResult.costUsd.toFixed(4),
        })
        .where(eq(schema.generationJobs.id, jobId));

      // Polish-23 Commit 3.0.19: ALSO persist the analysis to the
      // concept row's new metadata.analysis jsonb slot so future
      // Polish-23 jobs against the same concept reuse the vision
      // output without re-running Gemini. Merges with any prior
      // concept.metadata content so unrelated fields (uploaded via
      // form etc.) survive.
      if (visionResult.conceptId) {
        const conceptRow = await db.query.concepts.findFirst({
          where: eq(schema.concepts.id, visionResult.conceptId),
          columns: { metadata: true },
        });
        const priorConceptMeta = (conceptRow?.metadata as Record<string, unknown> | null) ?? {};
        await db
          .update(schema.concepts)
          .set({
            metadata: {
              ...priorConceptMeta,
              analysis: innerAnalysis,
              analyzed_at: new Date().toISOString(),
            },
          })
          .where(eq(schema.concepts.id, visionResult.conceptId));
      }
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
 * Polish-9.2 → Polish-20.0.2 hotfix: dispatch precedence.
 *   1. job.metadata.model_id set → generation/video-variant.requested
 *      (Polish-20 unified worker — reads model_id + provider_id from
 *      metadata to look up ModelProviderConfig)
 *   2. picked_pipeline set → descriptor's workerEvent (legacy survivors:
 *      heygen / sora / nano-banana)
 *   3. otherwise → default UGC (HeyGen) fallback so the job doesn't
 *      stall
 *
 * Returns 'generation/ugc.requested' on any error so the job doesn't
 * stall — the default worker exists for every user.
 *
 * Polish-20.0.2 hardening:
 *   - Reads metadata via extractMetadataObject() which handles both
 *     the expected object shape AND a JSON-string shape (defensive
 *     against postgres-js driver edge cases where jsonb rarely comes
 *     back as text)
 *   - Loud-logs the actual keys present on metadata + the metadata
 *     shape so a future misdispatch is diagnosable without a repro
 *   - When metadata.model_id is set but provider_id is missing,
 *     STILL dispatches to video-variant — the worker's fail-fast
 *     path surfaces a clear "Missing provider_id" error rather than
 *     silently routing to the wrong worker
 */
async function loadJobRoutingEvent(jobId: string): Promise<
  | 'generation/ugc.requested'
  | 'generation/sora.requested'
  | 'generation/nano-banana.requested'
  | 'generation/video-variant.requested'
  // Polish-23 Commit 1: reserved for the Commit-3 kie.ai Veo 3.1
  // Lite + Higgsfield Soul worker. Descriptor lookup in
  // pipeline-descriptors.ts already returns this string; typing
  // the union here now keeps analyze-concept in lockstep before
  // Commit 3 lands the worker.
  | 'generation/polish23-veo-lite.requested'
  // Polish-25 Commit 2: MakeUGC pre-cast avatar UGC ad. Descriptor
  // lookup already returns this string; typing the union keeps
  // analyze-concept in lockstep.
  | 'generation/polish25-makeugc.requested'
  // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad worker.
  | 'generation/static-openai.requested'
> {
  try {
    const db = getDb();
    const row = await db.query.generationJobs.findFirst({
      where: eq(schema.generationJobs.id, jobId),
      columns: { format: true, pickedPipeline: true, metadata: true },
    });
    const metadataObj = extractMetadataObject(row?.metadata ?? null);
    const modelIdFromMetadata =
      metadataObj && typeof metadataObj['model_id'] === 'string'
        ? (metadataObj['model_id'] as string)
        : null;
    const providerIdFromMetadata =
      metadataObj && typeof metadataObj['provider_id'] === 'string'
        ? (metadataObj['provider_id'] as string)
        : null;

    // Polish-20.0.2 diagnostic: always log the actual metadata shape
    // the dispatch is seeing. A production dispatch bug on job
    // 84fee5b7 was hard to diagnose because the dispatch decision
    // logged only its resolved branch, not what it read from metadata.
    console.log(
      `[analyze-concept] job ${jobId} dispatch inputs: ` +
        `pickedPipeline=${row?.pickedPipeline ?? 'null'} ` +
        `format=${row?.format ?? 'null'} ` +
        `metadata_shape=${describeMetadataShape(row?.metadata ?? null)} ` +
        `metadata_keys=${metadataObj ? JSON.stringify(Object.keys(metadataObj)) : '(none)'} ` +
        `metadata.model_id=${modelIdFromMetadata ?? 'null'} ` +
        `metadata.provider_id=${providerIdFromMetadata ?? 'null'}`,
    );

    if (modelIdFromMetadata) {
      console.log(
        `[analyze-concept] job ${jobId} dispatch: model_id=${modelIdFromMetadata} ` +
          `provider_id=${providerIdFromMetadata ?? 'null'} → ` +
          `workerEvent=generation/video-variant.requested (Polish-20 unified worker)`,
      );
      return 'generation/video-variant.requested';
    }
    const pipeline = pipelineFromString(row?.pickedPipeline);
    if (pipeline) {
      const workerEvent = describePipeline(pipeline).workerEvent;
      console.log(
        `[analyze-concept] job ${jobId} dispatch: pickedPipeline=${row?.pickedPipeline} → ` +
          `workerEvent=${workerEvent} (resolved from descriptor)`,
      );
      return workerEvent;
    }
    console.log(
      `[analyze-concept] job ${jobId} dispatch: no pickedPipeline + no metadata.model_id → ` +
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

/**
 * Polish-20.0.3: unwrap Gemini's inner `analysis` field so the
 * downstream video-variant worker reads metadata.analysis.subject
 * (etc.) at the flat level extractSourceScriptVerbatim and
 * resolveAutoVideoDuration expect.
 *
 * Gemini's response schema wraps everything under a top-level
 * `analysis` object PLUS a peer `draft_prompt` string:
 *   { analysis: { script_transcription, subject, ... }, draft_prompt }
 *
 * Pre-Polish-20.0.3 the entire response object was written as
 * `metadata.analysis`, producing metadata.analysis.analysis.subject
 * (double-nested) AND leaking draft_prompt into Claude's context —
 * Claude then copied the Sora-era bracketed section style instead
 * of writing yapper-style prose (production diagnostic on job
 * 395cc9b7).
 *
 * When the vision result already has the flat shape (older mock
 * paths, or a schema-drift edge case where Gemini emits fields at
 * the top level), the helper leaves it as-is.
 */
export function extractInnerVisionAnalysis(
  visionAnalysis: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!visionAnalysis || typeof visionAnalysis !== 'object') return {};
  const inner = (visionAnalysis as Record<string, unknown>)['analysis'];
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  // Already flat — return the whole object minus draft_prompt so it
  // can't leak into the worker's Claude context via the analysis
  // key path.
  const flat = { ...(visionAnalysis as Record<string, unknown>) };
  delete flat['draft_prompt'];
  return flat;
}

/**
 * Polish-20.0.2: defensive metadata shape handling. postgres-js
 * normally returns jsonb as parsed objects, but this helper handles
 * the edge case where the value comes back as a JSON string (driver
 * config drift, connection-pool serializer flip, etc.). Falls back
 * to null on any unexpected shape.
 */
export function extractMetadataObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to null
    }
  }
  return null;
}

function describeMetadataShape(raw: unknown): string {
  if (raw == null) return 'null';
  if (Array.isArray(raw)) return 'array';
  if (typeof raw === 'object') return 'object';
  return typeof raw;
}
