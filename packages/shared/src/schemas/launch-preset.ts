import { z } from 'zod';
import { META_OPTIMIZATION_GOALS, META_PLACEMENT_TYPES } from '../safety';

/**
 * Polish-25.2 Commit 16b: launch-preset input schema.
 *
 * Shared between the /settings/presets form (client) and the
 * create/update server actions so the validation surface is
 * identical either side of the wire. Field names + ranges mirror
 * the launch dialog inline form (job-review-client.tsx) — a preset
 * IS just a saved copy of that form.
 *
 * Countries: uppercase 2-letter codes, 1-25 per preset. Meta
 * accepts arbitrary ISO-3166 codes, so we DON'T pin against
 * SUPPORTED_TARGETING_COUNTRIES here — a user can save an offbeat
 * country if their offer targets it. The launch-time settings-form
 * schema is the one that gates the "default targeting" saved value
 * against the picker list.
 */
export const PRESET_NAME_MAX_CHARS = 60;
export const PRESET_COUNTRIES_MAX = 25;

export const LaunchPresetInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required.')
      .max(PRESET_NAME_MAX_CHARS, `Name must be ${PRESET_NAME_MAX_CHARS} characters or fewer.`),
    targetingCountries: z
      .array(
        z
          .string()
          .trim()
          .length(2, 'Country codes must be 2 letters.')
          .transform((s) => s.toUpperCase()),
      )
      .min(1, 'At least one country is required.')
      .max(PRESET_COUNTRIES_MAX, `At most ${PRESET_COUNTRIES_MAX} countries per preset.`),
    ageMin: z.number().int().min(13).max(65),
    ageMax: z.number().int().min(13).max(65),
    optimizationGoal: z.enum(META_OPTIMIZATION_GOALS),
    placementType: z.enum(META_PLACEMENT_TYPES),
    perAdDailyBudgetUsd: z.number().positive().max(1000),
  })
  .refine((v) => v.ageMin <= v.ageMax, {
    message: 'Min age must be ≤ max age.',
    path: ['ageMax'],
  });

export type LaunchPresetInput = z.infer<typeof LaunchPresetInputSchema>;
