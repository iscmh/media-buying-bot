'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { ConceptInputSchema, StaticConceptInputSchema, UgcConceptInputSchema } from '@mbb/shared';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import {
  conceptStoragePathBelongsToUser,
  isAllowedConceptMime,
  sanitizeConceptExt,
  stripConceptExtension,
  type ConceptUploadContentType,
} from './concept-upload-helpers';

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

// =========================================================================
// Polish-9.1: signed-URL direct upload for concept files
// =========================================================================

export interface CreateConceptUploadUrlResult {
  ok: boolean;
  uploadUrl?: string;
  storagePath?: string;
  conceptId?: string;
  errorMessage?: string;
}

/**
 * Polish-9.1: server action that returns a Supabase Storage signed
 * upload URL for a new concept file. Replaces the previous
 * "stream a 100 MB video through a Next server action" flow that
 * hit Vercel's 4.5 MB body cap and crashed the client on 413.
 *
 * The conceptId is generated here so the storage path is stable
 * before the DB row exists. confirmConceptUpload (below) inserts
 * the row using the same id.
 */
export async function createConceptUploadUrl(input: {
  filename: string;
  contentType: ConceptUploadContentType;
  fileContentType: string;
}): Promise<CreateConceptUploadUrlResult> {
  if (input.contentType !== 'static' && input.contentType !== 'ugc') {
    return { ok: false, errorMessage: 'Invalid concept type.' };
  }
  if (!isAllowedConceptMime(input.fileContentType, input.contentType)) {
    const want = input.contentType === 'static' ? 'PNG / JPEG / WEBP' : 'MP4 / MOV / WEBM';
    return {
      ok: false,
      errorMessage: `Unsupported file type: ${input.fileContentType || 'unknown'}. Use ${want}.`,
    };
  }

  const user = await requireUser();
  const conceptId = randomUUID();
  const ext = sanitizeConceptExt(input.filename);
  const storagePath = `${user.id}/concepts/${conceptId}/source${ext}`;

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from('concepts')
    .createSignedUploadUrl(storagePath);
  if (error || !data) {
    return {
      ok: false,
      errorMessage: error?.message ?? 'Could not create upload URL.',
    };
  }
  return {
    ok: true,
    uploadUrl: data.signedUrl,
    storagePath,
    conceptId,
  };
}

export interface ConfirmConceptUploadInput {
  conceptId: string;
  storagePath: string;
  contentType: ConceptUploadContentType;
  fileContentType: string;
  filename: string;
  name?: string;
  nicheTag?: string;
  sourcePlatform?: string;
  // Static-only metadata
  staticHeadline?: string;
  staticPrimaryText?: string;
  staticDescription?: string;
  // UGC-only metadata
  ugcOriginalScript?: string;
  // Shared
  offerUrl?: string;
  originalCpaUsd?: string;
  originalRoas?: string;
  description?: string;
}

export interface ConfirmConceptUploadResult {
  ok: boolean;
  conceptId?: string;
  errorMessage?: string;
}

/**
 * Polish-9.1: after the client PUTs the file to Supabase via the
 * signed URL, it calls this action to (1) verify the file is actually
 * present at the expected path, (2) insert the concept row.
 *
 * The storagePath MUST start with <userId>/concepts/ — checked here
 * defense-in-depth even though the bucket RLS enforces it too.
 */
export async function confirmConceptUpload(
  input: ConfirmConceptUploadInput,
): Promise<ConfirmConceptUploadResult> {
  const user = await requireUser();

  if (!conceptStoragePathBelongsToUser(input.storagePath, user.id)) {
    return { ok: false, errorMessage: 'Invalid storage path.' };
  }
  if (input.contentType !== 'static' && input.contentType !== 'ugc') {
    return { ok: false, errorMessage: 'Invalid concept type.' };
  }

  // Validate metadata via the same schemas the legacy FormData path uses.
  const raw = {
    contentType: input.contentType,
    staticHeadline: input.staticHeadline,
    staticPrimaryText: input.staticPrimaryText,
    staticDescription: input.staticDescription,
    ugcOriginalScript: input.ugcOriginalScript,
    nicheTag: input.nicheTag,
    sourcePlatform: input.sourcePlatform,
    offerUrl: input.offerUrl,
    originalCpaUsd: input.originalCpaUsd,
    originalRoas: input.originalRoas,
    description: input.description,
  };
  const schemaForType =
    input.contentType === 'static' ? StaticConceptInputSchema : UgcConceptInputSchema;
  const parsed = schemaForType.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorMessage: parsed.error.issues[0]?.message ?? 'Invalid concept input.',
    };
  }
  const finalParse = ConceptInputSchema.safeParse(parsed.data);
  if (!finalParse.success) {
    return { ok: false, errorMessage: 'Invalid concept input (post-parse).' };
  }
  const data = finalParse.data;

  // Verify the file made it to storage. Supabase Storage doesn't have a
  // cheap HEAD endpoint, so we use list() on the parent prefix and look
  // for the leaf — small payload, no download.
  const supabase = await getSupabaseServerClient();
  const dir = input.storagePath.slice(0, input.storagePath.lastIndexOf('/'));
  const leaf = input.storagePath.slice(input.storagePath.lastIndexOf('/') + 1);
  const { data: listed, error: listErr } = await supabase.storage
    .from('concepts')
    .list(dir, { limit: 100 });
  if (listErr) {
    return { ok: false, errorMessage: `Could not verify upload: ${listErr.message}` };
  }
  const found = (listed ?? []).find((o) => o.name === leaf);
  if (!found) {
    return {
      ok: false,
      errorMessage: 'Upload did not land in storage. Try again.',
    };
  }

  const name = input.name?.trim().length
    ? input.name.trim()
    : stripConceptExtension(input.filename);

  const db = getDb();
  try {
    await db.insert(schema.concepts).values({
      id: input.conceptId,
      userId: user.id,
      contentType: data.contentType,
      name,
      fileUrl: input.storagePath,
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
      status: 'approved',
    });
  } catch (err) {
    return {
      ok: false,
      errorMessage: `Could not save concept: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await logAuditEvent({
    userId: user.id,
    eventType: 'concept_created',
    eventData: {
      concept_id: input.conceptId,
      content_type: data.contentType,
      niche_tag: data.nicheTag ?? null,
      source_platform: data.sourcePlatform ?? null,
      file_content_type: input.fileContentType,
      via: 'signed_url',
      _meta: await auditMetaFromHeaders(),
    },
  });

  revalidatePath('/concepts');
  return { ok: true, conceptId: input.conceptId };
}
