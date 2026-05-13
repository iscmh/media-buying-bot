'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  PLATFORM_HARD_AI_CEILING_USD,
  PLATFORM_HARD_CEILING_USD,
  PLATFORM_HARD_LAUNCH_CEILING_USD,
  SettingsFormSchema,
  type SettingsFormInput,
} from '@mbb/shared';
import { getDb, logAuditEvent, saveUserSettings, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export interface SaveSettingsResult {
  ok: boolean;
  changedCount?: number;
  errorMessage?: string;
  fieldErrors?: Partial<Record<keyof SettingsFormInput, string>>;
}

/**
 * Save settings. Server-side validation + ceiling clamp + diff-only audit.
 *
 *  - Zod parses the raw form values (coerces numbers from strings).
 *  - platform_daily_spend_ceiling is hard-clamped to PLATFORM_HARD_CEILING_USD
 *    even if it slipped past the schema (defense in depth — the schema's
 *    .max() is the same value, but we don't want a future schema bump to
 *    silently lift the cap).
 *  - saveUserSettings handles the diff + audit + write.
 *  - Returns { changedCount } so the toast can say "saved 3 changes" or
 *    "no changes" without another round-trip.
 */
export async function saveSettingsAction(
  payload: Record<string, unknown>,
): Promise<SaveSettingsResult> {
  const parsed = SettingsFormSchema.safeParse(payload);
  if (!parsed.success) {
    const fieldErrors: SaveSettingsResult['fieldErrors'] = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[0] as keyof SettingsFormInput | undefined;
      if (path && !fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return { ok: false, errorMessage: 'Some fields are invalid.', fieldErrors };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const next = {
    ...parsed.data,
    platformDailySpendCeiling: Math.min(
      parsed.data.platformDailySpendCeiling,
      PLATFORM_HARD_CEILING_USD,
    ),
    aiGenerationDailyCapUsd: Math.min(
      parsed.data.aiGenerationDailyCapUsd,
      PLATFORM_HARD_AI_CEILING_USD,
    ),
    dailyLaunchBudgetCapUsd: Math.min(
      parsed.data.dailyLaunchBudgetCapUsd,
      PLATFORM_HARD_LAUNCH_CEILING_USD,
    ),
    defaultAdDailyBudgetUsd: Math.min(
      parsed.data.defaultAdDailyBudgetUsd,
      PLATFORM_HARD_AD_DAILY_BUDGET_USD,
    ),
  };

  const changes = await saveUserSettings(user.id, next);
  revalidatePath('/settings');
  return { ok: true, changedCount: changes.length };
}

async function requireUserId(): Promise<string> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user.id;
}

/**
 * Phase 5: first-time kill ack. Idempotent. Records the timestamp so
 * the bot's callback handler can verify the user has read the "kill
 * just pauses, reversible in Ads Manager" explainer before letting
 * Confirm Kill go through. Subsequent kills skip this check.
 */
export async function acknowledgeKillAction(): Promise<{ ok: boolean; errorMessage?: string }> {
  const userId = await requireUserId();
  const db = getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { killAcknowledgedAt: true },
  });
  if (existing?.killAcknowledgedAt) return { ok: true };
  await db
    .update(schema.userSettings)
    .set({ killAcknowledgedAt: new Date() })
    .where(eq(schema.userSettings.userId, userId));
  await logAuditEvent({
    userId,
    eventType: 'kill_first_acknowledged',
    eventData: { _meta: await auditMetaFromHeaders() },
  });
  return { ok: true };
}

/**
 * Phase 5: first-time scale ack. Idempotent. Records the timestamp so
 * the bot's callback handler can verify the user has read the "scale
 * increases real spend" explainer before letting Confirm Scale go
 * through. Subsequent scales skip this check.
 */
export async function acknowledgeScaleAction(): Promise<{ ok: boolean; errorMessage?: string }> {
  const userId = await requireUserId();
  const db = getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { scaleAcknowledgedAt: true },
  });
  if (existing?.scaleAcknowledgedAt) return { ok: true };
  await db
    .update(schema.userSettings)
    .set({ scaleAcknowledgedAt: new Date() })
    .where(eq(schema.userSettings.userId, userId));
  await logAuditEvent({
    userId,
    eventType: 'scale_first_acknowledged',
    eventData: { _meta: await auditMetaFromHeaders() },
  });
  return { ok: true };
}
