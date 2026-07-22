'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { LaunchPresetInputSchema, type LaunchPresetInput } from '@mbb/shared';
import { getDb, schema } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export interface PresetActionResult {
  ok: boolean;
  errorMessage?: string;
  fieldErrors?: Partial<Record<keyof LaunchPresetInput, string>>;
  presetId?: string;
}

async function requireUserId(): Promise<string> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user.id;
}

function parsePayload(
  payload: Record<string, unknown>,
): { ok: true; data: LaunchPresetInput } | { ok: false; result: PresetActionResult } {
  const parsed = LaunchPresetInputSchema.safeParse(payload);
  if (!parsed.success) {
    const fieldErrors: PresetActionResult['fieldErrors'] = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[0] as keyof LaunchPresetInput | undefined;
      if (path && !fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return {
      ok: false,
      result: { ok: false, errorMessage: 'Some fields are invalid.', fieldErrors },
    };
  }
  return { ok: true, data: parsed.data };
}

export async function createPresetAction(
  payload: Record<string, unknown>,
): Promise<PresetActionResult> {
  const userId = await requireUserId();
  const check = parsePayload(payload);
  if (!check.ok) return check.result;
  const { data } = check;
  const db = getDb();
  try {
    const [row] = await db
      .insert(schema.userLaunchPresets)
      .values({
        userId,
        name: data.name,
        targetingCountries: data.targetingCountries,
        ageMin: data.ageMin,
        ageMax: data.ageMax,
        optimizationGoal: data.optimizationGoal,
        placementType: data.placementType,
        perAdDailyBudgetUsd: data.perAdDailyBudgetUsd.toFixed(2),
      })
      .returning({ id: schema.userLaunchPresets.id });
    revalidatePath('/settings/presets');
    return { ok: true, presetId: row?.id };
  } catch (err) {
    // Duplicate name lands here via the unique (user_id, lower(name))
    // index. Zod already handles the too-long / empty cases.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('user_launch_presets_user_id_name_uniq')) {
      return {
        ok: false,
        errorMessage: 'A preset with that name already exists.',
        fieldErrors: { name: 'Already used.' },
      };
    }
    return { ok: false, errorMessage: msg };
  }
}

export async function updatePresetAction(
  presetId: string,
  payload: Record<string, unknown>,
): Promise<PresetActionResult> {
  const userId = await requireUserId();
  const check = parsePayload(payload);
  if (!check.ok) return check.result;
  const { data } = check;
  const db = getDb();
  try {
    const result = await db
      .update(schema.userLaunchPresets)
      .set({
        name: data.name,
        targetingCountries: data.targetingCountries,
        ageMin: data.ageMin,
        ageMax: data.ageMax,
        optimizationGoal: data.optimizationGoal,
        placementType: data.placementType,
        perAdDailyBudgetUsd: data.perAdDailyBudgetUsd.toFixed(2),
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.userLaunchPresets.id, presetId), eq(schema.userLaunchPresets.userId, userId)),
      )
      .returning({ id: schema.userLaunchPresets.id });
    if (result.length === 0) {
      return { ok: false, errorMessage: 'Preset not found.' };
    }
    revalidatePath('/settings/presets');
    return { ok: true, presetId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('user_launch_presets_user_id_name_uniq')) {
      return {
        ok: false,
        errorMessage: 'A preset with that name already exists.',
        fieldErrors: { name: 'Already used.' },
      };
    }
    return { ok: false, errorMessage: msg };
  }
}

export async function deletePresetAction(presetId: string): Promise<PresetActionResult> {
  const userId = await requireUserId();
  const db = getDb();
  const result = await db
    .delete(schema.userLaunchPresets)
    .where(
      and(eq(schema.userLaunchPresets.id, presetId), eq(schema.userLaunchPresets.userId, userId)),
    )
    .returning({ id: schema.userLaunchPresets.id });
  if (result.length === 0) {
    return { ok: false, errorMessage: 'Preset not found.' };
  }
  revalidatePath('/settings/presets');
  return { ok: true };
}

export interface PresetRow {
  id: string;
  name: string;
  targetingCountries: string[];
  ageMin: number;
  ageMax: number;
  optimizationGoal: string;
  placementType: string;
  perAdDailyBudgetUsd: number;
}

export async function loadPresetsForUser(userId: string): Promise<PresetRow[]> {
  const db = getDb();
  const rows = await db.query.userLaunchPresets.findMany({
    where: eq(schema.userLaunchPresets.userId, userId),
    orderBy: asc(schema.userLaunchPresets.name),
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    targetingCountries: r.targetingCountries,
    ageMin: r.ageMin,
    ageMax: r.ageMax,
    optimizationGoal: r.optimizationGoal,
    placementType: r.placementType,
    perAdDailyBudgetUsd: Number(r.perAdDailyBudgetUsd),
  }));
}
