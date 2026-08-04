import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { apiError, apiOk } from '@/lib/api-envelope';
import { withApi } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polish-25.10 Commit 59: GET /api/v1/generations/:id
 *
 * Returns the job + all its variants (paginated via variant fields).
 */
export const GET = withApi('generations.get', async (_req, ctx) => {
  const id = String(ctx.params?.id ?? '');
  if (!id) return apiError('validation_error', 'Missing generation id.');
  const db = getDb();
  const job = await db.query.generationJobs.findFirst({
    where: and(eq(schema.generationJobs.id, id), eq(schema.generationJobs.userId, ctx.userId)),
  });
  if (!job) return apiError('not_found', 'Generation not found.');
  const variants = await db.query.generatedCreatives.findMany({
    where: and(
      eq(schema.generatedCreatives.generationJobId, id),
      eq(schema.generatedCreatives.userId, ctx.userId),
      isNull(schema.generatedCreatives.deletedAt),
    ),
    orderBy: desc(schema.generatedCreatives.createdAt),
  });
  return apiOk({
    id: job.id,
    status: job.status,
    concept_ids: job.conceptIds,
    variants_requested: job.variantCount,
    pipeline: job.pickedPipeline,
    format: job.format,
    mode: job.mode,
    estimated_cost_usd: job.estimatedCostUsd ? Number(job.estimatedCostUsd) : null,
    actual_cost_usd: job.actualCostUsd ? Number(job.actualCostUsd) : null,
    generated_count: job.generatedCreativeCount,
    error_message: job.errorMessage,
    created_at: job.createdAt.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
    variants: variants.map((v) => ({
      id: v.id,
      file_url: v.fileUrl,
      aspect_ratio: v.aspectRatio,
      status: v.status,
      format: v.format,
      headline: v.headline,
      primary_text: v.primaryText,
      description: v.description,
      created_at: v.createdAt.toISOString(),
    })),
  });
});
