import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  MAX_VARIANTS_PER_JOB,
  describePipeline,
  estimateGenerationCost,
  pipelineFromString,
  type ConceptType,
} from '@mbb/shared';
import { assertDailyCostCap, getDb, logAuditEvent, schema } from '@mbb/db';
import { apiError, apiOk } from '@/lib/api-envelope';
import { parseJsonBody, withApi } from '@/lib/api-auth';
import { sendGenerationJobEvent } from '@/lib/inngest/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateGenerationBody = z.object({
  concept_id: z.string().uuid(),
  variants: z.number().int().min(1).max(MAX_VARIANTS_PER_JOB),
  intensity: z.enum(['small', 'medium', 'big']).default('medium'),
  pipeline: z.string().optional(),
  mode: z.enum(['mock', 'live']).default('live'),
  static_openai_quality: z.enum(['low', 'medium', 'high']).optional(),
});

/**
 * Polish-25.10 Commit 59: POST /api/v1/generations
 *
 * Mirrors createGenerationJobAction but keyed off API key. Pre-flight
 * gates the caller through the same safety helpers the web action
 * uses (assertDailyCostCap, live-ack, cost estimator) so no
 * asymmetric spend risk.
 */
export const POST = withApi('generations.create', async (req, ctx) => {
  const parsed = await parseJsonBody(req, CreateGenerationBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const db = getDb();
  const concept = await db.query.concepts.findFirst({
    where: and(eq(schema.concepts.id, body.concept_id), eq(schema.concepts.userId, ctx.userId)),
    columns: { contentType: true },
  });
  if (!concept) return apiError('not_found', 'Concept not found.');
  const contentType = concept.contentType as ConceptType;

  const detectedPipeline = pipelineFromString(body.pipeline ?? null);
  const pipelineDesc = detectedPipeline
    ? describePipeline(detectedPipeline)
    : describePipeline('heygen_avatar_talking_head');
  const format = pipelineDesc.format;

  const estimate = estimateGenerationCost({
    conceptType: contentType,
    variantCount: body.variants,
    pipeline: pipelineDesc.pipeline,
  });
  const cap = await assertDailyCostCap(ctx.userId, estimate.estimateUsd);
  if (!cap.allowed) {
    return apiError('forbidden', cap.reason);
  }

  // Live-ack gate — same as web. Skipped for mock jobs.
  if (body.mode === 'live') {
    const settings = await db.query.userSettings.findFirst({
      where: eq(schema.userSettings.userId, ctx.userId),
      columns: { liveGenerationAcknowledgedAt: true },
    });
    if (!settings?.liveGenerationAcknowledgedAt) {
      return apiError(
        'forbidden',
        'Live-spend acknowledgment required. Visit /concepts/<id>/generate in the web UI once to complete the confirmation dialog.',
      );
    }
  }

  const [row] = await db
    .insert(schema.generationJobs)
    .values({
      userId: ctx.userId,
      conceptIds: [body.concept_id],
      intensity: body.intensity,
      variantCount: body.variants,
      providerChoice:
        pipelineDesc.providerChoice ?? (contentType === 'static' ? 'gemini+claude' : null),
      estimatedCostUsd: estimate.estimateUsd.toFixed(4),
      mode: body.mode,
      status: 'queued',
      format,
      pickedPipeline: pipelineDesc.pipeline,
      ...(body.static_openai_quality
        ? { metadata: { static_openai_quality: body.static_openai_quality } }
        : {}),
    })
    .returning({ id: schema.generationJobs.id });

  const jobId = row?.id;
  if (!jobId) return apiError('internal_error', 'Could not create job row.', { status: 500 });

  await logAuditEvent({
    userId: ctx.userId,
    eventType: 'generation_job_created',
    eventData: {
      job_id: jobId,
      concept_id: body.concept_id,
      content_type: contentType,
      variant_count: body.variants,
      pipeline: pipelineDesc.pipeline,
      via: 'api_v1',
      api_key_id: ctx.apiKeyId,
    },
  });

  await sendGenerationJobEvent({
    contentType,
    jobId,
    userId: ctx.userId,
    mode: body.mode,
    pickedPipeline: pipelineDesc.pipeline,
  });

  return apiOk(
    {
      id: jobId,
      concept_id: body.concept_id,
      status: 'queued',
      variants: body.variants,
      pipeline: pipelineDesc.pipeline,
      mode: body.mode,
      estimated_cost_usd: Number(estimate.estimateUsd.toFixed(4)),
    },
    { status: 201 },
  );
});

const ListGenerationsQuery = z.object({
  status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/v1/generations?status=completed&limit=50&offset=0
 */
export const GET = withApi('generations.list', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = ListGenerationsQuery.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!parsed.success) {
    return apiError(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid query parameters.',
    );
  }
  const { status, limit, offset } = parsed.data;
  const db = getDb();
  const rows = await db.query.generationJobs.findMany({
    where: status
      ? and(eq(schema.generationJobs.userId, ctx.userId), eq(schema.generationJobs.status, status))
      : eq(schema.generationJobs.userId, ctx.userId),
    orderBy: desc(schema.generationJobs.createdAt),
    limit,
    offset,
    columns: {
      id: true,
      status: true,
      conceptIds: true,
      variantCount: true,
      pickedPipeline: true,
      format: true,
      mode: true,
      estimatedCostUsd: true,
      actualCostUsd: true,
      generatedCreativeCount: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
    },
  });
  return apiOk({
    limit,
    offset,
    generations: rows.map((r) => ({
      id: r.id,
      status: r.status,
      concept_ids: r.conceptIds,
      variants: r.variantCount,
      pipeline: r.pickedPipeline,
      format: r.format,
      mode: r.mode,
      estimated_cost_usd: r.estimatedCostUsd ? Number(r.estimatedCostUsd) : null,
      actual_cost_usd: r.actualCostUsd ? Number(r.actualCostUsd) : null,
      generated_count: r.generatedCreativeCount,
      error_message: r.errorMessage,
      created_at: r.createdAt.toISOString(),
      completed_at: r.completedAt?.toISOString() ?? null,
    })),
  });
});
