'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { TOS_VERSION, TosAcceptSchema } from '@mbb/shared';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Records ToS acceptance for the authed user. Writes
 * users.tos_accepted_at + users.tos_version, then audit-logs the event.
 */
export async function acceptTosAction(formData: FormData) {
  const parsed = TosAcceptSchema.safeParse({
    agreed: formData.get('agreed') === 'on',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid submission.' };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const db = getDb();
  await db
    .update(schema.users)
    .set({ tosAcceptedAt: new Date(), tosVersion: TOS_VERSION })
    .where(eq(schema.users.id, user.id));

  await logAuditEvent({
    userId: user.id,
    eventType: 'tos_accepted',
    eventData: { tos_version: TOS_VERSION },
  });

  revalidatePath('/onboarding/tos');
  redirect('/onboarding/risk');
}
