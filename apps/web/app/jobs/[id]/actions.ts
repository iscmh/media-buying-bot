'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';

type Decision = 'approved' | 'rejected';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * Approve or reject a single variant. Idempotent (re-clicking the same
 * decision is a no-op).
 */
export async function decideVariantAction(
  variantId: string,
  decision: Decision,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const user = await requireUser();
  const db = getDb();

  const variant = await db.query.generatedCreatives.findFirst({
    where: and(
      eq(schema.generatedCreatives.id, variantId),
      eq(schema.generatedCreatives.userId, user.id),
    ),
    columns: { id: true, status: true, generationJobId: true },
  });
  if (!variant) {
    return { ok: false, errorMessage: 'Variant not found.' };
  }
  if (variant.status === decision) {
    return { ok: true };
  }

  await db
    .update(schema.generatedCreatives)
    .set({ status: decision })
    .where(eq(schema.generatedCreatives.id, variantId));

  await logAuditEvent({
    userId: user.id,
    eventType: decision === 'approved' ? 'variant_approved' : 'variant_rejected',
    eventData: {
      variant_id: variantId,
      job_id: variant.generationJobId,
      _meta: await auditMetaFromHeaders(),
    },
  });

  revalidatePath(`/jobs/${variant.generationJobId}`);
  return { ok: true };
}

/**
 * Bulk decide every variant in a job that's still in 'ready_for_review'.
 * Skips already-decided variants so re-clicks are safe.
 */
export async function bulkDecideJobAction(
  jobId: string,
  decision: Decision,
): Promise<{ ok: boolean; updated?: number; errorMessage?: string }> {
  const user = await requireUser();
  const db = getDb();

  // Verify job ownership before bulk update.
  const job = await db.query.generationJobs.findFirst({
    where: and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.userId, user.id)),
    columns: { id: true },
  });
  if (!job) return { ok: false, errorMessage: 'Job not found.' };

  const result = await db
    .update(schema.generatedCreatives)
    .set({ status: decision })
    .where(
      and(
        eq(schema.generatedCreatives.generationJobId, jobId),
        eq(schema.generatedCreatives.status, 'ready_for_review'),
      ),
    )
    .returning({ id: schema.generatedCreatives.id });

  await logAuditEvent({
    userId: user.id,
    eventType: decision === 'approved' ? 'variants_bulk_approved' : 'variants_bulk_rejected',
    eventData: {
      job_id: jobId,
      updated_count: result.length,
      _meta: await auditMetaFromHeaders(),
    },
  });

  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, updated: result.length };
}
