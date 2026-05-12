'use server';

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
import { saveUserSettings } from '@mbb/db';
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
