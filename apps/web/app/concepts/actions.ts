'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { ConceptInputSchema, StaticConceptInputSchema, UgcConceptInputSchema } from '@mbb/shared';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';

const STATIC_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const UGC_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const STATIC_MIME_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UGC_MIME_ALLOWED = new Set(['video/mp4', 'video/quicktime']);

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

export interface CreateConceptResult {
  ok: boolean;
  conceptId?: string;
  errorMessage?: string;
}

/**
 * Create a concept (Static or UGC). Single round-trip: file upload + row
 * insert in one server action. The order is deterministic:
 *
 *   1. Generate a UUID for the concept up front (so the storage path is
 *      stable before the row exists).
 *   2. Validate the metadata + file (mime + size).
 *   3. Upload the file via the server-side Supabase client at
 *      `<user_id>/concepts/<concept_id>/<filename>` — RLS-scoped storage
 *      policy added in Phase 1's 0006 covers this path.
 *   4. Insert the concept row with file_url pointing at the storage path.
 *      We store the storage path (not a public URL) so we can sign a
 *      one-time URL on display.
 *   5. Audit log + redirect to /concepts/<id>.
 *
 * If step 3 succeeds but step 4 fails (transient DB error), the file is
 * orphaned. Phase 3b cron can scan for orphans; for Phase 3a manual
 * cleanup is fine — failure here is rare and the file is in the user's
 * own storage prefix.
 */
export async function createConceptAction(formData: FormData): Promise<CreateConceptResult> {
  const contentType = formData.get('contentType');
  if (contentType !== 'static' && contentType !== 'ugc') {
    return { ok: false, errorMessage: 'Invalid concept type.' };
  }

  // Pull metadata fields. Optional fields come back as empty strings from
  // the form; coerce empty → undefined so zod's .optional() handles them.
  const raw = {
    contentType,
    staticHeadline: stringField(formData, 'staticHeadline'),
    staticPrimaryText: stringField(formData, 'staticPrimaryText'),
    staticDescription: stringField(formData, 'staticDescription'),
    ugcOriginalScript: stringField(formData, 'ugcOriginalScript'),
    nicheTag: stringField(formData, 'nicheTag'),
    sourcePlatform: stringField(formData, 'sourcePlatform'),
    offerUrl: stringField(formData, 'offerUrl'),
    originalCpaUsd: stringField(formData, 'originalCpaUsd'),
    originalRoas: stringField(formData, 'originalRoas'),
    description: stringField(formData, 'description'),
  };

  const schemaForType = contentType === 'static' ? StaticConceptInputSchema : UgcConceptInputSchema;
  const parsed = schemaForType.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorMessage: parsed.error.issues[0]?.message ?? 'Invalid concept input.',
    };
  }

  // Validate the file payload.
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, errorMessage: 'Pick a file to upload.' };
  }
  const allowed = contentType === 'static' ? STATIC_MIME_ALLOWED : UGC_MIME_ALLOWED;
  const maxBytes = contentType === 'static' ? STATIC_MAX_BYTES : UGC_MAX_BYTES;
  if (!allowed.has(file.type)) {
    return {
      ok: false,
      errorMessage: `Unsupported file type: ${file.type || 'unknown'}.`,
    };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      errorMessage: `File too large (${formatMB(file.size)}). Max ${formatMB(maxBytes)}.`,
    };
  }

  const user = await requireUser();
  const conceptId = randomUUID();
  const ext = sanitizeExt(file.name);
  const storagePath = `${user.id}/concepts/${conceptId}/source${ext}`;

  // Polish-3 display name. Form may post an explicit `name`; otherwise
  // default to the uploaded filename with extension stripped.
  const explicitName = stringField(formData, 'name');
  const name = explicitName ?? stripExtension(file.name);

  // Upload via the user-scoped Supabase client so RLS applies. Service-
  // role would also work but using the user's session keeps the audit
  // trail honest (the user uploaded it, not the server).
  const supabase = await getSupabaseServerClient();
  const { error: uploadError } = await supabase.storage
    .from('concepts')
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError) {
    return {
      ok: false,
      errorMessage: `Upload failed: ${uploadError.message}`,
    };
  }

  // Validate via the discriminated union before insert (defense vs. type
  // narrowing slip in the branched parse above).
  const finalParse = ConceptInputSchema.safeParse(parsed.data);
  if (!finalParse.success) {
    return { ok: false, errorMessage: 'Invalid concept input (post-parse).' };
  }
  const data = finalParse.data;

  const db = getDb();
  await db.insert(schema.concepts).values({
    id: conceptId,
    userId: user.id,
    contentType: data.contentType,
    name,
    fileUrl: storagePath,
    description: data.description ?? null,
    nicheTag: data.nicheTag ?? null,
    sourcePlatform: data.sourcePlatform ?? null,
    offerUrl: data.offerUrl ? data.offerUrl : null,
    originalCpaUsd: data.originalCpaUsd != null ? data.originalCpaUsd.toFixed(2) : null,
    originalRoas: data.originalRoas != null ? data.originalRoas.toFixed(2) : null,
    staticHeadline: data.contentType === 'static' ? data.staticHeadline : null,
    staticPrimaryText: data.contentType === 'static' ? data.staticPrimaryText : null,
    staticDescription: data.contentType === 'static' ? (data.staticDescription ?? null) : null,
    ugcOriginalScript: data.contentType === 'ugc' ? (data.ugcOriginalScript ?? null) : null,
    status: 'approved', // operator uploaded it; we trust it for generation
  });

  await logAuditEvent({
    userId: user.id,
    eventType: 'concept_created',
    eventData: {
      concept_id: conceptId,
      content_type: data.contentType,
      niche_tag: data.nicheTag ?? null,
      source_platform: data.sourcePlatform ?? null,
      file_size_bytes: file.size,
      _meta: await auditMetaFromHeaders(),
    },
  });

  revalidatePath('/concepts');
  return { ok: true, conceptId };
}

/**
 * Polish-3: inline rename from /concepts/[id]. Server-validates ownership
 * via service-role + explicit user_id match (RLS would also catch this,
 * but the redundancy is cheap and the error message is friendlier).
 */
export async function renameConceptAction(input: {
  conceptId: string;
  name: string;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const trimmed = input.name.trim();
  if (trimmed.length === 0) {
    return { ok: false, errorMessage: 'Name cannot be empty.' };
  }
  if (trimmed.length > 120) {
    return { ok: false, errorMessage: 'Name capped at 120 characters.' };
  }

  const user = await requireUser();
  const db = getDb();
  const result = await db
    .update(schema.concepts)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(and(eq(schema.concepts.id, input.conceptId), eq(schema.concepts.userId, user.id)))
    .returning({ id: schema.concepts.id });
  if (result.length === 0) {
    return { ok: false, errorMessage: 'Concept not found.' };
  }

  await logAuditEvent({
    userId: user.id,
    eventType: 'concept_renamed',
    eventData: {
      concept_id: input.conceptId,
      new_name: trimmed,
      _meta: await auditMetaFromHeaders(),
    },
  });

  revalidatePath('/concepts');
  revalidatePath(`/concepts/${input.conceptId}`);
  return { ok: true };
}

function stringField(formData: FormData, key: string): string | undefined {
  const v = formData.get(key);
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeExt(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  const ext = filename.slice(idx).toLowerCase();
  // Allow only a small whitelist of extensions matching our MIME allow-list.
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov']);
  return allowed.has(ext) ? ext : '';
}

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  const base = idx > 0 ? filename.slice(0, idx) : filename;
  // Trim path separators if the browser ever leaks them, and cap length so
  // a 300-char filename doesn't blow the column.
  return base.split(/[\\/]/).pop()!.trim().slice(0, 120) || 'Untitled concept';
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
