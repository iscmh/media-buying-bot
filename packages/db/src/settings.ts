import { eq } from 'drizzle-orm';
import type { MetaOptimizationGoal, MetaPlacementType } from '@mbb/shared';
import { logAuditEvent } from './audit';
import { getDb } from './client';
import { userSettings } from './schema/settings';
import { users } from './schema/users';

/**
 * Settings read + write helpers.
 *
 * Numeric Postgres columns come back as strings via postgres-js (the driver
 * preserves precision). We parse to Number on read and toFixed() on write
 * so callers always work with regular JS numbers and the diff helper can
 * compare them with === without surprises.
 *
 * `timezone` lives on the users table (Phase 1 schema decision) but rolls
 * into this helper so the form save can be atomic across both rows.
 */

export interface SettingsRow {
  defaultTestCap: number;
  adSetsPerLaunch: number;
  dailyGenerationVolume: number;
  campaignObjective: 'CBO' | 'ABO';
  killThresholdCpc: number;
  killThresholdCtr: number;
  gracePeriodMinutes: number;
  hour6CutoffEnabled: boolean;
  scaleTier1Cap: number;
  scaleTier2Cap: number;
  manualApprovalThreshold: number;
  platformDailySpendCeiling: number;
  aiGenerationDailyCapUsd: number;
  // Phase 4a — launch defaults.
  dailyLaunchBudgetCapUsd: number;
  defaultAdDailyBudgetUsd: number;
  defaultOptimizationGoal: MetaOptimizationGoal;
  defaultPlacementType: MetaPlacementType;
  // Phase 4b — Meta targeting defaults.
  defaultPageId: string | null;
  defaultTargetingCountries: string[];
  defaultAgeMin: number;
  defaultAgeMax: number;
  // Phase 5 — kill/scale thresholds.
  pollingIntervalMinutes: number;
  killMaxCpcUsd: number;
  killNoConvSpendUsd: number;
  killMinCtrPct: number;
  scaleMinRoas: number;
  scaleMinSpendUsd: number;
  scaleIncrementPct: number;
  scaleMaxDailyBudgetUsd: number;
  // Polish-25.7 Commit 39 — per-user ROAS fallback denominator.
  assumedConversionValueUsd: number;
  // Phase 6 — daily Telegram digest.
  dailySummaryEnabled: boolean;
  dailySummaryHourLocal: number;
  timezone: string;
}

export async function getUserSettings(userId: string): Promise<SettingsRow | null> {
  const db = getDb();
  const [settingsRow, userRow] = await Promise.all([
    db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) }),
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { timezone: true },
    }),
  ]);
  if (!settingsRow || !userRow) return null;
  return {
    defaultTestCap: Number(settingsRow.defaultTestCap),
    adSetsPerLaunch: settingsRow.adSetsPerLaunch,
    dailyGenerationVolume: settingsRow.dailyGenerationVolume,
    campaignObjective: settingsRow.campaignObjective,
    killThresholdCpc: Number(settingsRow.killThresholdCpc),
    killThresholdCtr: Number(settingsRow.killThresholdCtr),
    gracePeriodMinutes: settingsRow.gracePeriodMinutes,
    hour6CutoffEnabled: settingsRow.hour6CutoffEnabled,
    scaleTier1Cap: Number(settingsRow.scaleTier1Cap),
    scaleTier2Cap: Number(settingsRow.scaleTier2Cap),
    manualApprovalThreshold: Number(settingsRow.manualApprovalThreshold),
    platformDailySpendCeiling: Number(settingsRow.platformDailySpendCeiling),
    aiGenerationDailyCapUsd: Number(settingsRow.aiGenerationDailyCapUsd),
    dailyLaunchBudgetCapUsd: Number(settingsRow.dailyLaunchBudgetCapUsd),
    defaultAdDailyBudgetUsd: Number(settingsRow.defaultAdDailyBudgetUsd),
    defaultOptimizationGoal: settingsRow.defaultOptimizationGoal as MetaOptimizationGoal,
    defaultPlacementType: settingsRow.defaultPlacementType as MetaPlacementType,
    defaultPageId: settingsRow.defaultPageId,
    defaultTargetingCountries: settingsRow.defaultTargetingCountries,
    defaultAgeMin: settingsRow.defaultAgeMin,
    defaultAgeMax: settingsRow.defaultAgeMax,
    pollingIntervalMinutes: settingsRow.pollingIntervalMinutes,
    killMaxCpcUsd: Number(settingsRow.killMaxCpcUsd),
    killNoConvSpendUsd: Number(settingsRow.killNoConvSpendUsd),
    killMinCtrPct: Number(settingsRow.killMinCtrPct),
    scaleMinRoas: Number(settingsRow.scaleMinRoas),
    scaleMinSpendUsd: Number(settingsRow.scaleMinSpendUsd),
    scaleIncrementPct: Number(settingsRow.scaleIncrementPct),
    scaleMaxDailyBudgetUsd: Number(settingsRow.scaleMaxDailyBudgetUsd),
    assumedConversionValueUsd: Number(settingsRow.assumedConversionValueUsd),
    dailySummaryEnabled: settingsRow.dailySummaryEnabled,
    dailySummaryHourLocal: settingsRow.dailySummaryHourLocal,
    timezone: userRow.timezone,
  };
}

export interface SettingsChange {
  field: keyof SettingsRow;
  oldValue: SettingsRow[keyof SettingsRow];
  newValue: SettingsRow[keyof SettingsRow];
}

/**
 * Compute the field-level diff between current DB values and proposed new
 * values. Only returns fields whose value actually changed. Used for the
 * settings audit log so we capture intent (what the operator changed)
 * rather than a full snapshot.
 */
export function diffSettings(current: SettingsRow, next: SettingsRow): SettingsChange[] {
  const changes: SettingsChange[] = [];
  const keys = Object.keys(current) as (keyof SettingsRow)[];
  for (const key of keys) {
    if (current[key] !== next[key]) {
      changes.push({ field: key, oldValue: current[key], newValue: next[key] });
    }
  }
  return changes;
}

/**
 * Persist a new settings row. Caller is responsible for clamping
 * platformDailySpendCeiling against PLATFORM_HARD_CEILING_USD. Numeric
 * columns are written as strings (Drizzle's contract for `numeric`).
 *
 * Wraps both the user_settings UPDATE and the users.timezone UPDATE in a
 * single transaction so the diff log captures them atomically — partial
 * saves on transient failure could leave audit-log gaps that lie about
 * what actually happened.
 *
 * Returns the changes that were actually written. If `next` matches the
 * current row exactly, returns [] and writes nothing — including no audit
 * log row (no-op submit shouldn't pollute the log).
 */
export async function saveUserSettings(
  userId: string,
  next: SettingsRow,
): Promise<SettingsChange[]> {
  const current = await getUserSettings(userId);
  if (!current) {
    throw new Error(`saveUserSettings: no user_settings row for user ${userId}`);
  }
  const changes = diffSettings(current, next);
  if (changes.length === 0) return [];

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(userSettings)
      .set({
        defaultTestCap: next.defaultTestCap.toFixed(2),
        adSetsPerLaunch: next.adSetsPerLaunch,
        dailyGenerationVolume: next.dailyGenerationVolume,
        campaignObjective: next.campaignObjective,
        killThresholdCpc: next.killThresholdCpc.toFixed(4),
        killThresholdCtr: next.killThresholdCtr.toFixed(2),
        gracePeriodMinutes: next.gracePeriodMinutes,
        hour6CutoffEnabled: next.hour6CutoffEnabled,
        scaleTier1Cap: next.scaleTier1Cap.toFixed(2),
        scaleTier2Cap: next.scaleTier2Cap.toFixed(2),
        manualApprovalThreshold: next.manualApprovalThreshold.toFixed(2),
        platformDailySpendCeiling: next.platformDailySpendCeiling.toFixed(2),
        aiGenerationDailyCapUsd: next.aiGenerationDailyCapUsd.toFixed(2),
        dailyLaunchBudgetCapUsd: next.dailyLaunchBudgetCapUsd.toFixed(2),
        defaultAdDailyBudgetUsd: next.defaultAdDailyBudgetUsd.toFixed(2),
        defaultOptimizationGoal: next.defaultOptimizationGoal,
        defaultPlacementType: next.defaultPlacementType,
        defaultPageId: next.defaultPageId,
        defaultTargetingCountries: next.defaultTargetingCountries,
        defaultAgeMin: next.defaultAgeMin,
        defaultAgeMax: next.defaultAgeMax,
        pollingIntervalMinutes: next.pollingIntervalMinutes,
        killMaxCpcUsd: next.killMaxCpcUsd.toFixed(2),
        killNoConvSpendUsd: next.killNoConvSpendUsd.toFixed(2),
        killMinCtrPct: next.killMinCtrPct.toFixed(2),
        scaleMinRoas: next.scaleMinRoas.toFixed(2),
        scaleMinSpendUsd: next.scaleMinSpendUsd.toFixed(2),
        scaleIncrementPct: next.scaleIncrementPct.toFixed(2),
        scaleMaxDailyBudgetUsd: next.scaleMaxDailyBudgetUsd.toFixed(2),
        assumedConversionValueUsd: next.assumedConversionValueUsd.toFixed(2),
        dailySummaryEnabled: next.dailySummaryEnabled,
        dailySummaryHourLocal: next.dailySummaryHourLocal,
      })
      .where(eq(userSettings.userId, userId));

    if (changes.some((c) => c.field === 'timezone')) {
      await tx.update(users).set({ timezone: next.timezone }).where(eq(users.id, userId));
    }
  });

  await logAuditEvent({
    userId,
    eventType: 'settings_changed',
    eventData: {
      changes: changes.map((c) => ({
        field: c.field,
        old_value: c.oldValue,
        new_value: c.newValue,
      })),
    },
  });

  return changes;
}
