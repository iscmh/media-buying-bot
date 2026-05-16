'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Phase 3f: persist the user's default HeyGen avatar (and optionally
 * voice) so the UGC pipeline can read it on every generation. Empty
 * string clears the override and falls back to the env / smart-match
 * chain.
 */
export interface SaveDefaultAvatarResult {
  ok: boolean;
  errorMessage?: string;
}

export async function saveDefaultHeygenAvatarAction(
  formData: FormData,
): Promise<SaveDefaultAvatarResult> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const avatarId = String(formData.get('avatarId') ?? '').trim();
  // Voice is optional — present only if the picker UI surfaces it.
  const voiceIdRaw = formData.get('voiceId');
  const voiceId = typeof voiceIdRaw === 'string' ? voiceIdRaw.trim() : null;

  const db = getDb();
  await db
    .update(schema.userSettings)
    .set({
      defaultHeygenAvatarId: avatarId.length > 0 ? avatarId : null,
      ...(voiceId !== null ? { defaultHeygenVoiceId: voiceId.length > 0 ? voiceId : null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.userSettings.userId, user.id));

  await logAuditEvent({
    userId: user.id,
    eventType: 'settings_updated',
    eventData: {
      field: 'default_heygen_avatar_id',
      avatar_id: avatarId || null,
      voice_id: voiceId,
      _meta: await auditMetaFromHeaders(),
    },
  });

  revalidatePath('/settings');
  return { ok: true };
}
