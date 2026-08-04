import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { apiError, apiOk } from '@/lib/api-envelope';
import { withApi } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polish-25.10 Commit 59: GET /api/v1/concepts/:id
 */
export const GET = withApi('concepts.get', async (_req, ctx) => {
  const id = String(ctx.params?.id ?? '');
  if (!id) return apiError('validation_error', 'Missing concept id.');
  const db = getDb();
  const row = await db.query.concepts.findFirst({
    where: and(
      eq(schema.concepts.id, id),
      eq(schema.concepts.userId, ctx.userId),
      isNull(schema.concepts.deletedAt),
    ),
  });
  if (!row) return apiError('not_found', 'Concept not found.');
  return apiOk({
    id: row.id,
    content_type: row.contentType,
    name: row.name,
    file_url: row.fileUrl,
    status: row.status,
    description: row.description,
    niche_tag: row.nicheTag,
    source_platform: row.sourcePlatform,
    offer_url: row.offerUrl,
    original_cpa_usd: row.originalCpaUsd,
    original_roas: row.originalRoas,
    static_headline: row.staticHeadline,
    static_primary_text: row.staticPrimaryText,
    static_description: row.staticDescription,
    ugc_original_script: row.ugcOriginalScript,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
});
