import { eq } from 'drizzle-orm';
import { logAuditEvent } from './audit';
import { getDb } from './client';
import { userSettings } from './schema/settings';

/**
 * Settings read + write helpers.
 *
 * Numeric Postgres columns come back as strings via postgres-js (the driver
 * preserves precision). We parse to Number on read and toFixed() on write
 * so callers always work with regular JS numbers and the diff helper can
 * compare them with === without surprises.
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
}

export async function getUserSettings(userId: string): Promise<SettingsRow | null> {
  const db = getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!row) return null;
  return {
    defaultTestCap: Number(row.defaultTestCap),
    adSetsPerLaunch: row.adSetsPerLaunch,
    dailyGenerationVolume: row.dailyGenerationVolume,
    campaignObjective: row.campaignObjective,
    killThresholdCpc: Number(row.killThresholdCpc),
    killThresholdCtr: Number(row.killThresholdCtr),
    gracePeriodMinutes: row.gracePeriodMinutes,
    hour6CutoffEnabled: row.hour6CutoffEnabled,
    scaleTier1Cap: Number(row.scaleTier1Cap),
    scaleTier2Cap: Number(row.scaleTier2Cap),
    manualApprovalThreshold: Number(row.manualApprovalThreshold),
    platformDailySpendCeiling: Number(row.platformDailySpendCeiling),
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
  await db
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
    })
    .where(eq(userSettings.userId, userId));

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
