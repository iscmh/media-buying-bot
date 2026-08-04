import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { apiError, apiOk } from '@/lib/api-envelope';
import { parseJsonBody, withApi } from '@/lib/api-auth';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATIC_MAX_BYTES = 10 * 1024 * 1024;
const UGC_MAX_BYTES = 100 * 1024 * 1024;
const STATIC_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UGC_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

const CreateConceptBody = z.object({
  source_url: z.string().url(),
  content_type: z.enum(['static', 'ugc']),
  name: z.string().min(1).max(120).optional(),
  niche_tag: z.string().max(80).optional(),
  source_platform: z.string().max(80).optional(),
  offer_url: z.string().url().optional(),
  description: z.string().max(2000).optional(),
});

/**
 * Polish-25.10 Commit 59: POST /api/v1/concepts
 *
 * Fetches source_url server-side, uploads to Supabase Storage under
 * <user_id>/concepts/<uuid>/source.<ext>, then inserts the concept row.
 *
 * We fetch server-side (not signed-URL like the web flow) because the
 * API caller doesn't have a browser to PUT from. Hard-cap at the
 * content-type's byte ceiling so a hostile URL can't OOM the lambda.
 */
export const POST = withApi('concepts.create', async (req, ctx) => {
  const parsed = await parseJsonBody(req, CreateConceptBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = getSupabaseServiceClient();
  const db = getDb();

  // Fetch source_url. Cap the response to the content-type's max size
  // by reading a bounded stream. Anything larger than the cap is rejected.
  const maxBytes = body.content_type === 'static' ? STATIC_MAX_BYTES : UGC_MAX_BYTES;
  const allowed = body.content_type === 'static' ? STATIC_MIMES : UGC_MIMES;

  let sourceResponse: Response;
  try {
    sourceResponse = await fetch(body.source_url, { redirect: 'follow' });
  } catch (err) {
    return apiError(
      'validation_error',
      `Could not fetch source_url: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!sourceResponse.ok) {
    return apiError('validation_error', `source_url returned HTTP ${sourceResponse.status}.`);
  }
  const contentType =
    (sourceResponse.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!allowed.has(contentType)) {
    return apiError(
      'validation_error',
      `Unsupported content-type "${contentType}" for ${body.content_type}. Allowed: ${[...allowed].join(', ')}.`,
    );
  }
  const declaredLength = Number(sourceResponse.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) {
    return apiError(
      'validation_error',
      `source_url too large (${(declaredLength / 1024 / 1024).toFixed(1)}MB). Max ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`,
    );
  }
  const buffer = await sourceResponse.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return apiError(
      'validation_error',
      `source_url too large after read (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB).`,
    );
  }

  const ext = extForMime(contentType);
  const conceptId = crypto.randomUUID();
  const storagePath = `${ctx.userId}/concepts/${conceptId}/source${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('concepts')
    .upload(storagePath, buffer, { contentType, upsert: false });
  if (uploadErr) {
    return apiError('internal_error', `Storage upload failed: ${uploadErr.message}`, {
      status: 500,
    });
  }

  const name = body.name?.trim() ?? deriveNameFromUrl(body.source_url);
  try {
    await db.insert(schema.concepts).values({
      id: conceptId,
      userId: ctx.userId,
      contentType: body.content_type,
      name,
      fileUrl: storagePath,
      description: body.description ?? null,
      nicheTag: body.niche_tag ?? null,
      sourcePlatform: body.source_platform ?? null,
      offerUrl: body.offer_url ?? null,
      status: 'approved',
    });
  } catch (err) {
    // Best-effort cleanup of the orphaned upload.
    void supabase.storage.from('concepts').remove([storagePath]);
    return apiError(
      'internal_error',
      `Could not save concept: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  }

  await logAuditEvent({
    userId: ctx.userId,
    eventType: 'concept_created',
    eventData: {
      concept_id: conceptId,
      content_type: body.content_type,
      via: 'api_v1',
      api_key_id: ctx.apiKeyId,
      source_url: body.source_url,
    },
  });

  return apiOk(
    {
      id: conceptId,
      content_type: body.content_type,
      name,
      file_url: storagePath,
      status: 'approved',
    },
    { status: 201 },
  );
});

const ListConceptsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/v1/concepts?limit=50&offset=0
 */
export const GET = withApi('concepts.list', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = ListConceptsQuery.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!parsed.success) {
    return apiError(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid query parameters.',
    );
  }
  const { limit, offset } = parsed.data;

  const db = getDb();
  const rows = await db.query.concepts.findMany({
    where: and(eq(schema.concepts.userId, ctx.userId), isNull(schema.concepts.deletedAt)),
    orderBy: desc(schema.concepts.createdAt),
    limit,
    offset,
    columns: {
      id: true,
      contentType: true,
      name: true,
      fileUrl: true,
      status: true,
      nicheTag: true,
      sourcePlatform: true,
      createdAt: true,
    },
  });
  return apiOk({
    limit,
    offset,
    concepts: rows.map((r) => ({
      id: r.id,
      content_type: r.contentType,
      name: r.name,
      file_url: r.fileUrl,
      status: r.status,
      niche_tag: r.nicheTag,
      source_platform: r.sourcePlatform,
      created_at: r.createdAt.toISOString(),
    })),
  });
});

function extForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'video/mp4':
      return '.mp4';
    case 'video/quicktime':
      return '.mov';
    case 'video/webm':
      return '.webm';
    default:
      return '';
  }
}

function deriveNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() ?? 'Untitled';
    const dotIdx = base.lastIndexOf('.');
    const stripped = dotIdx > 0 ? base.slice(0, dotIdx) : base;
    return stripped.slice(0, 120) || 'Untitled concept';
  } catch {
    return 'Untitled concept';
  }
}
