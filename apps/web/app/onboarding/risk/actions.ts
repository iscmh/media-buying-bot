'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { RiskAcknowledgmentSchema, TOS_VERSION } from '@mbb/shared';
import { logAuditEvent } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function acknowledgeRiskAction(formData: FormData) {
  const parsed = RiskAcknowledgmentSchema.safeParse({
    scrolled: formData.get('scrolled') === 'true',
    ack1: formData.get('ack1') === 'on',
    ack2: formData.get('ack2') === 'on',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid submission.' };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  await logAuditEvent({
    userId: user.id,
    eventType: 'risk_education_acknowledged',
    eventData: {
      tos_version: TOS_VERSION,
      scrolled: true,
      ack1: true,
      ack2: true,
      acknowledged_at: new Date().toISOString(),
    },
  });

  revalidatePath('/onboarding/risk');
  // Polish-25.2 Commit 13: fixed 404. Chain is tos → risk → keys
  // (per Commit 10a's ONBOARDING_STEPS trim); the pre-Commit-10a
  // "→ meta" target no longer exists.
  redirect('/onboarding/keys');
}
