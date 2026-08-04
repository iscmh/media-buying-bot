import { and, eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { apiError, apiOk } from '@/lib/api-envelope';
import { withApi } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polish-25.10 Commit 59: POST /api/v1/generations/:id/variants/:variant_id/reject
 */
export const POST = withApi('variants.reject', async (_req, ctx) => {
  const jobId = String(ctx.params?.id ?? '');
  const variantId = String(ctx.params?.variantId ?? '');
  if (!jobId || !variantId) return apiError('validation_error', 'Missing route param.');
  const db = getDb();
  const variant = await db.query.generatedCreatives.findFirst({
    where: and(
      eq(schema.generatedCreatives.id, variantId),
      eq(schema.generatedCreatives.userId, ctx.userId),
      eq(schema.generatedCreatives.generationJobId, jobId),
    ),
    columns: { id: true, status: true },
  });
  if (!variant) return apiError('not_found', 'Variant not found.');
  if (variant.status === 'rejected') {
    return apiOk({ id: variant.id, status: 'rejected', changed: false });
  }
  await db
    .update(schema.generatedCreatives)
    .set({ status: 'rejected' })
    .where(eq(schema.generatedCreatives.id, variantId));
  await logAuditEvent({
    userId: ctx.userId,
    eventType: 'variant_rejected',
    eventData: {
      variant_id: variantId,
      job_id: jobId,
      via: 'api_v1',
      api_key_id: ctx.apiKeyId,
    },
  });
  return apiOk({ id: variant.id, status: 'rejected', changed: true });
});
