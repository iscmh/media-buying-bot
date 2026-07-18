/**
 * Polish-23 Commit 3.0.19: Zod schema for the extended vision-
 * analysis shape emitted by POLISH23_VISION_SYSTEM_PROMPT.
 *
 * Persisted to concepts.metadata.analysis (primary) and mirrored
 * onto generation_jobs.metadata.analysis for Polish-21 legacy
 * compat. Read by the Polish-23 Step A source-priority chain to
 * seed CHARACTER LOCK generation.
 *
 * Parser is DEFENSIVE: partial-shape Gemini output falls back to
 * the operator-tuned UGC_DECONSTRUCTOR schema (which has
 * script_transcription + subject.appearance + social_context but
 * no structured persona) and the Polish-23 chain either uses those
 * as best-effort or falls through to lower-priority sources
 * (ugc_original_script → prior-job → linda_fallback).
 */
import { z } from 'zod';

export const POLISH23_PERSONA_GENDER_VALUES = ['male', 'female', 'ambiguous'] as const;
export type Polish23PersonaGender = (typeof POLISH23_PERSONA_GENDER_VALUES)[number];

export const POLISH23_PERSONA_ETHNICITY_VALUES = [
  'white',
  'black',
  'asian',
  'hispanic',
  'middle_eastern',
  'mixed',
  'other',
] as const;
export type Polish23PersonaEthnicity = (typeof POLISH23_PERSONA_ETHNICITY_VALUES)[number];

export const POLISH23_HOOK_STRUCTURE_VALUES = ['question', 'statement', 'story', 'reveal'] as const;
export type Polish23HookStructure = (typeof POLISH23_HOOK_STRUCTURE_VALUES)[number];

export const POLISH23_INTERIOR_EXTERIOR_VALUES = ['interior', 'exterior'] as const;
export type Polish23InteriorExterior = (typeof POLISH23_INTERIOR_EXTERIOR_VALUES)[number];

export const Polish23PersonaSchema = z.object({
  gender: z.enum(POLISH23_PERSONA_GENDER_VALUES),
  age_range: z.string().min(1),
  ethnicity: z.enum(POLISH23_PERSONA_ETHNICITY_VALUES),
  look: z.string().min(1),
  voice_tone: z.string().min(1),
});
export type Polish23Persona = z.infer<typeof Polish23PersonaSchema>;

export const Polish23SettingDetailsSchema = z.object({
  interior_or_exterior: z.enum(POLISH23_INTERIOR_EXTERIOR_VALUES),
  room_or_place: z.string().min(1),
  lighting: z.string().min(1),
  key_props: z.array(z.string().min(1)).min(1),
});
export type Polish23SettingDetails = z.infer<typeof Polish23SettingDetailsSchema>;

export const Polish23EmotionalArcSchema = z.object({
  starting_emotion: z.string().min(1),
  ending_emotion: z.string().min(1),
  key_beats: z.array(z.string().min(1)).min(3).max(6),
});
export type Polish23EmotionalArc = z.infer<typeof Polish23EmotionalArcSchema>;

/**
 * The Polish-23 additions layered ON TOP of the Polish-21
 * UGC_DECONSTRUCTOR schema. Fields at this level are STRUCTURED
 * data intended for Claude Step A + Higgsfield Soul prompt
 * construction.
 */
export const Polish23VisionAdditionsSchema = z.object({
  persona: Polish23PersonaSchema,
  setting_details: Polish23SettingDetailsSchema,
  emotional_arc: Polish23EmotionalArcSchema,
  hook_structure: z.enum(POLISH23_HOOK_STRUCTURE_VALUES),
  niche_category: z.string().min(1),
});
export type Polish23VisionAdditions = z.infer<typeof Polish23VisionAdditionsSchema>;

/**
 * Parse the raw Gemini analysis blob for Polish-23 additions. If
 * any required field is missing or malformed, returns null — the
 * caller falls through the source-priority chain rather than
 * ship a half-hydrated record.
 */
export function parsePolish23VisionAdditions(rawAnalysis: unknown): Polish23VisionAdditions | null {
  if (!rawAnalysis || typeof rawAnalysis !== 'object') return null;
  const result = Polish23VisionAdditionsSchema.safeParse(rawAnalysis);
  return result.success ? result.data : null;
}
