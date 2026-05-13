import { z } from 'zod';
import {
  META_OPTIMIZATION_GOALS,
  META_PLACEMENT_TYPES,
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  PLATFORM_HARD_AI_CEILING_USD,
  PLATFORM_HARD_CEILING_USD,
  PLATFORM_HARD_LAUNCH_CEILING_USD,
} from './safety';
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

  // Phase 4a: Meta auto-launch defaults. Server clamps the budget cap to
  // PLATFORM_HARD_LAUNCH_CEILING_USD and the per-ad budget to
  // PLATFORM_HARD_AD_DAILY_BUDGET_USD.
  dailyLaunchBudgetCapUsd: z.coerce
    .number()
    .min(10, 'Daily launch budget cap must be at least $10.')
    .max(
      PLATFORM_HARD_LAUNCH_CEILING_USD,
      `Daily launch budget cap cannot exceed $${PLATFORM_HARD_LAUNCH_CEILING_USD}.`,
    ),
  defaultAdDailyBudgetUsd: z.coerce
    .number()
    .min(2, 'Per-ad daily budget must be at least $2.')
    .max(
      PLATFORM_HARD_AD_DAILY_BUDGET_USD,
      `Per-ad daily budget cannot exceed $${PLATFORM_HARD_AD_DAILY_BUDGET_USD}.`,
    ),
  defaultOptimizationGoal: z.enum(META_OPTIMIZATION_GOALS),
  defaultPlacementType: z.enum(META_PLACEMENT_TYPES),

  // Phase 4b: Meta launch targeting defaults. defaultPageId is nullable
  // since first-time users haven't fetched their pages yet. age_min/max
  // narrow to Meta's allowed [13, 65] window (we default to 18-65, no
  // operational reason to go below 18 for our verticals).
  defaultPageId: z.union([z.string().min(1), z.null()]),
  defaultTargetingCountries: z
    .array(z.string().regex(/^[A-Z]{2}$/, 'Use ISO 3166-1 alpha-2 codes (e.g. US, CA, GB).'))
    .min(1, 'At least one country must be selected.'),
  defaultAgeMin: z.coerce.number().int().min(13).max(65),
  defaultAgeMax: z.coerce.number().int().min(13).max(65),

  // Phase 5 — kill/scale thresholds. Server clamps the budget-ish ones
  // to the platform daily-launch ceiling (a $1000 max-budget scale
  // can't sneak past the launch cap that already protects the user).
  pollingIntervalMinutes: z.coerce.number().int().min(15).max(240),
  killMaxCpcUsd: z.coerce.number().min(0.1).max(20),
  killNoConvSpendUsd: z.coerce.number().min(1).max(200),
  killMinCtrPct: z.coerce.number().min(0).max(10),
  scaleMinRoas: z.coerce.number().min(0.5).max(50),
  scaleMinSpendUsd: z.coerce.number().min(5).max(500),
  scaleIncrementPct: z.coerce.number().min(10).max(200),
  scaleMaxDailyBudgetUsd: z.coerce.number().min(10).max(1000),

  // Phase 6 — daily Telegram digest. Hour is 0–23 in the user's tz.
  dailySummaryEnabled: z.coerce.boolean(),
  dailySummaryHourLocal: z.coerce.number().int().min(0).max(23),

  // Daily-summary timezone. Lives on users.timezone in the schema (Phase 1
  // decision), but rolled into the same form so save can write atomically.
  // Validation accepts the full IANA db, not just the picker's curated list.
  timezone: z
    .string()
    .min(1, 'Pick a timezone.')
    .refine(isValidIanaZone, 'Pick a valid IANA timezone (e.g. America/New_York).'),
});
export type SettingsFormInput = z.infer<typeof SettingsFormSchema>;

// Cross-field validation: age_min must be <= age_max.
export const SettingsFormSchemaRefined = SettingsFormSchema.refine(
  (v) => v.defaultAgeMin <= v.defaultAgeMax,
  { message: 'Min age must be ≤ max age.', path: ['defaultAgeMin'] },
);

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
  'dailyLaunchBudgetCapUsd',
  'defaultAdDailyBudgetUsd',
  'defaultOptimizationGoal',
  'defaultPlacementType',
  'defaultPageId',
  'defaultTargetingCountries',
  'defaultAgeMin',
  'defaultAgeMax',
  'pollingIntervalMinutes',
  'killMaxCpcUsd',
  'killNoConvSpendUsd',
  'killMinCtrPct',
  'scaleMinRoas',
  'scaleMinSpendUsd',
  'scaleIncrementPct',
  'scaleMaxDailyBudgetUsd',
  'dailySummaryEnabled',
  'dailySummaryHourLocal',
  'timezone',
] as const satisfies ReadonlyArray<keyof SettingsFormInput>;

/** Phase 4b — countries the launch defaults dropdown offers. Operator
 *  picks the ones they're licensed in; full list is too long for a
 *  picker. Add more here as we expand. */
export const SUPPORTED_TARGETING_COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'IE', name: 'Ireland' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
] as const;
