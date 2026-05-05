import { z } from 'zod';
import { PLATFORM_HARD_AI_CEILING_USD, PLATFORM_HARD_CEILING_USD } from './safety';
import { isValidIanaZone } from './timezone';

/**
 * Zod schema for the settings form. Drives both client-side react-hook-form
 * validation and the server action that writes to user_settings.
 *
 * Numeric fields use coerce because the form posts strings. Bounds match
 * the operator-friendly limits described in the help text on the page.
 *
 * platform_daily_spend_ceiling is clamped server-side to PLATFORM_HARD_CEILING_USD
 * — the UI shows the cap, the schema accepts up to it.
 */
export const SettingsFormSchema = z.object({
  defaultTestCap: z.coerce
    .number()
    .min(5, 'Test cap must be at least $5.')
    .max(200, 'Test cap should not exceed $200 — that defeats the point of testing.'),
  adSetsPerLaunch: z.coerce
    .number()
    .int('Whole numbers only.')
    .min(1, 'At least one ad set per launch.')
    .max(20, 'No more than 20 ad sets per launch — Meta starts treating you like a bot.'),
  dailyGenerationVolume: z.coerce
    .number()
    .int('Whole numbers only.')
    .min(10, 'Generate at least 10 variants/day to give the bot enough material.')
    .max(200, 'Cap at 200/day; beyond that storage and review costs explode.'),
  campaignObjective: z.enum(['CBO', 'ABO']),

  killThresholdCpc: z.coerce
    .number()
    .min(0.1, 'CPC threshold must be at least $0.10.')
    .max(10, 'CPC threshold above $10 disables the kill rule effectively.'),
  killThresholdCtr: z.coerce
    .number()
    .min(0.5, 'CTR threshold below 0.5% lets too much through.')
    .max(10, 'CTR threshold above 10% kills almost everything.'),
  gracePeriodMinutes: z.coerce
    .number()
    .int('Whole minutes only.')
    .min(15, 'At least 15 minutes — you need a real signal.')
    .max(120, 'More than 120 minutes wastes test budget.'),
  hour6CutoffEnabled: z.coerce.boolean(),

  scaleTier1Cap: z.coerce
    .number()
    .min(50, 'Tier 1 cap must be at least $50.')
    .max(2000, 'Tier 1 cap above $2000 — handle that with manual approvals.'),
  scaleTier2Cap: z.coerce
    .number()
    .min(100, 'Tier 2 cap must be at least $100.')
    .max(5000, 'Tier 2 cap above $5000 — handle that with manual approvals.'),
  manualApprovalThreshold: z.coerce
    .number()
    .min(100, 'Approval threshold must be at least $100.')
    .max(10000, 'Approval threshold above $10000 makes the gate meaningless.'),

  platformDailySpendCeiling: z.coerce
    .number()
    .min(50, 'Daily ceiling must be at least $50.')
    .max(
      PLATFORM_HARD_CEILING_USD,
      `Daily ceiling cannot exceed the platform hard ceiling of $${PLATFORM_HARD_CEILING_USD}.`,
    ),

  // Phase 3a: per-day AI generation cost cap. Server clamps to
  // PLATFORM_HARD_AI_CEILING_USD ($200) — same belt-and-suspenders pattern
  // as platformDailySpendCeiling.
  aiGenerationDailyCapUsd: z.coerce
    .number()
    .min(5, 'AI generation cap must be at least $5.')
    .max(
      PLATFORM_HARD_AI_CEILING_USD,
      `AI generation cap cannot exceed the platform hard ceiling of $${PLATFORM_HARD_AI_CEILING_USD}.`,
    ),

  // Daily-summary timezone. Lives on users.timezone in the schema (Phase 1
  // decision), but rolled into the same form so save can write atomically.
  // Validation accepts the full IANA db, not just the picker's curated list.
  timezone: z
    .string()
    .min(1, 'Pick a timezone.')
    .refine(isValidIanaZone, 'Pick a valid IANA timezone (e.g. America/New_York).'),
});
export type SettingsFormInput = z.infer<typeof SettingsFormSchema>;

/** All field keys, in display order. Used for diffing and audit logging. */
export const SETTINGS_FIELD_KEYS = [
  'defaultTestCap',
  'adSetsPerLaunch',
  'dailyGenerationVolume',
  'campaignObjective',
  'killThresholdCpc',
  'killThresholdCtr',
  'gracePeriodMinutes',
  'hour6CutoffEnabled',
  'scaleTier1Cap',
  'scaleTier2Cap',
  'manualApprovalThreshold',
  'platformDailySpendCeiling',
  'aiGenerationDailyCapUsd',
  'timezone',
] as const satisfies ReadonlyArray<keyof SettingsFormInput>;
