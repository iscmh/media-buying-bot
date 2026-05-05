'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Phase 3b: first-time live-mode acknowledgment. Called by the dialog
 * when the user clicks "I understand, proceed" on their first live
 * generation.
 *
 * Sets user_settings.live_generation_acknowledged_at = now() and audit-
 * logs `live_generation_first_acknowledged` with the IP/UA from headers.
 * Subsequent live submissions skip the dialog (the form checks the flag
 * before showing the modal).
 *
 * Idempotent: if the flag is already set, no-op.
 */
export async function acknowledgeLiveGenerationAction(): Promise<{
  ok: boolean;
  errorMessage?: string;
}> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const db = getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, user.id),
    columns: { liveGenerationAcknowledgedAt: true },
  });

  if (existing?.liveGenerationAcknowledgedAt) {
    return { ok: true }; // already acknowledged, idempotent no-op
  }

  await db
    .update(schema.userSettings)
    .set({ liveGenerationAcknowledgedAt: new Date() })
    .where(eq(schema.userSettings.userId, user.id));

  await logAuditEvent({
    userId: user.id,
    eventType: 'live_generation_first_acknowledged',
    eventData: { _meta: await auditMetaFromHeaders() },
  });

  return { ok: true };
}
