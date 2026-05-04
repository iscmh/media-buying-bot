import { z } from 'zod';

/**
 * User-configurable bot settings. Each user's runtime behavior is governed
 * by this object. Platform-level safety caps (defined in env, not here)
 * sit ABOVE these values — the platform always picks the stricter value.
 */
export const UserSettingsSchema = z.object({
  defaultTestCap: z.number().positive().max(1000).default(20),
  adSetsPerLaunch: z.number().int().positive().max(20).default(5),
  dailyGenerationVolume: z.number().int().positive().max(200).default(40),
  campaignObjective: z.enum(['CBO', 'ABO']).default('CBO'),

  killThresholdCpc: z.number().positive().default(2.5),
  killThresholdCtr: z.number().positive().max(100).default(2.0),
  gracePeriodMinutes: z.number().int().nonnegative().max(240).default(30),
  hour6CutoffEnabled: z.boolean().default(true),

  scaleTier1Cap: z.number().positive().default(200),
  scaleTier2Cap: z.number().positive().default(400),
  manualApprovalThreshold: z.number().positive().default(400),

  // Platform enforces a stricter ceiling above this if env value is lower.
  platformDailySpendCeiling: z.number().positive().default(500),

  timezone: z.string().min(1).default('America/New_York'),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;
