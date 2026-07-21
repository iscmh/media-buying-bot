/**
 * Polish-25 Commit 7: MakeUGC avatar thumbnail vision analyzer.
 *
 * Prompt asks Gemini 2.5 Flash to look at a single avatar
 * thumbnail and emit STRUCTURED JSON describing the person's
 * on-screen appearance. Consumed by refresh-makeugc-avatar-index
 * to populate makeugc_avatar_index, which the polish25-makeugc
 * worker's matcher then joins against.
 *
 * The Zod schema is intentionally STRICT — every field required,
 * every enum closed. If Gemini can't confidently classify a
 * field, the prompt tells it to pick the closest bucket AND set
 * confidence_note (freeform); this way we still get a row we can
 * match against, and the caller can log ambiguous cases without
 * dropping the analysis.
 *
 * Downstream consumers:
 *   - refresh-makeugc-avatar-index Inngest cron
 *   - selectMakeugcAvatarForPersonaFromIndex matcher
 */
import { z } from 'zod';

// ---------------------------------------------------------------
// Enums — these MUST match the SQL column comments in
// supabase/migrations/0037_makeugc_avatar_index.sql. Any change
// here requires a data migration for existing enriched rows.
// ---------------------------------------------------------------

export const MAKEUGC_AGE_BUCKETS = ['20s', '30s', '40s', '50s', '60s', '70s', '80s+'] as const;
export type MakeugcAgeBucket = (typeof MAKEUGC_AGE_BUCKETS)[number];

export const MAKEUGC_ETHNICITIES = [
  'white',
  'black',
  'asian',
  'hispanic',
  'latino',
  'middle_eastern',
  'mixed',
  'other',
] as const;
export type MakeugcEthnicity = (typeof MAKEUGC_ETHNICITIES)[number];

export const MAKEUGC_HAIR_COLORS = [
  'black',
  'brown',
  'blonde',
  'gray',
  'white',
  'red',
  'bald',
  'other',
] as const;
export type MakeugcHairColor = (typeof MAKEUGC_HAIR_COLORS)[number];

export const MAKEUGC_FACIAL_HAIRS = [
  'clean_shaven',
  'stubble',
  'mustache',
  'beard',
  'goatee',
] as const;
export type MakeugcFacialHair = (typeof MAKEUGC_FACIAL_HAIRS)[number];

export const MAKEUGC_WARDROBE_STYLES = [
  'casual',
  'business_casual',
  'formal',
  'athletic',
  'creative',
  'other',
] as const;
export type MakeugcWardrobeStyle = (typeof MAKEUGC_WARDROBE_STYLES)[number];

export const MAKEUGC_BACKGROUND_SETTINGS = [
  'studio',
  'indoor_home',
  'indoor_office',
  'outdoor',
  'neutral',
  'other',
] as const;
export type MakeugcBackgroundSetting = (typeof MAKEUGC_BACKGROUND_SETTINGS)[number];

// ---------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------

export const MakeugcAvatarVisionAnalysisSchema = z.object({
  age_bucket: z.enum(MAKEUGC_AGE_BUCKETS),
  ethnicity: z.enum(MAKEUGC_ETHNICITIES),
  hair_color: z.enum(MAKEUGC_HAIR_COLORS),
  // hair_style / facial_hair are optional at the DB layer (text vs
  // text-not-null) but required from Gemini so the analysis is
  // complete; DB stores null when the enum value doesn't apply
  // (e.g. facial_hair on a female-presenting avatar).
  hair_style: z.string().min(1).max(80),
  facial_hair: z.enum(MAKEUGC_FACIAL_HAIRS),
  wardrobe_style: z.enum(MAKEUGC_WARDROBE_STYLES),
  wardrobe_summary: z.string().min(1).max(200),
  background_setting: z.enum(MAKEUGC_BACKGROUND_SETTINGS),
  /** Freeform note when Gemini had to guess on any field. Empty
   *  string when the classification was clear. */
  confidence_note: z.string().max(400),
});
export type MakeugcAvatarVisionAnalysis = z.infer<typeof MakeugcAvatarVisionAnalysisSchema>;

export function parseMakeugcAvatarVisionAnalysis(raw: unknown): MakeugcAvatarVisionAnalysis | null {
  const result = MakeugcAvatarVisionAnalysisSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------

export const MAKEUGC_AVATAR_VISION_SYSTEM_PROMPT = `You analyze a single UGC-ad avatar thumbnail image and emit
STRUCTURED JSON describing the on-screen person for a persona-
matching database.

OUTPUT: return ONE JSON object matching the schema below.
Return ONLY that JSON. No prose. No markdown fences. If a field
is genuinely ambiguous, pick the closest bucket AND record the
ambiguity in confidence_note.

SCHEMA (all fields required):
{
  "age_bucket":         "20s" | "30s" | "40s" | "50s" | "60s" | "70s" | "80s+",
  "ethnicity":          "white" | "black" | "asian" | "hispanic" | "latino" |
                        "middle_eastern" | "mixed" | "other",
  "hair_color":         "black" | "brown" | "blonde" | "gray" | "white" |
                        "red" | "bald" | "other",
  "hair_style":         freeform 1-8 word descriptor
                        ("short pompadour", "shoulder-length wavy",
                        "buzz cut", "curly natural", "long straight"),
  "facial_hair":        "clean_shaven" | "stubble" | "mustache" |
                        "beard" | "goatee",
  "wardrobe_style":     "casual" | "business_casual" | "formal" |
                        "athletic" | "creative" | "other",
  "wardrobe_summary":   1-sentence description of visible clothing
                        ("navy blue t-shirt", "gray hoodie over
                        white tee", "business suit with tie"),
  "background_setting": "studio" | "indoor_home" | "indoor_office" |
                        "outdoor" | "neutral" | "other",
  "confidence_note":    empty string when clear, else brief note
                        on any field you had to guess on
                        ("could be 20s or 30s — ambiguous lighting").
}

CLASSIFICATION GUIDELINES:

1. AGE BUCKET: pick the decade of visible apparent age. If the
   person straddles two decades (e.g. late 30s / early 40s),
   pick the LOWER bucket and record the ambiguity in
   confidence_note. Never emit a bucket that isn't in the
   enum.

2. ETHNICITY: use closed enum. "hispanic" and "latino" are
   distinct — pick "hispanic" when the presentation reads
   Spanish/Iberian, "latino" when it reads Latin American.
   "mixed" for visibly multiple heritages. "other" only when
   genuinely uncertain — record in confidence_note.

3. HAIR COLOR: primary/dominant color. "bald" for no visible
   hair. Choose "gray" for salt-and-pepper > 40% gray. "other"
   for unusual colors (pink, blue, etc.) — describe in
   hair_style.

4. HAIR STYLE: 1-8 word descriptor. Real examples: "short
   pompadour", "shoulder-length wavy", "buzz cut", "curly
   natural", "long straight center-part".

5. FACIAL HAIR: choose "clean_shaven" for none, "stubble" for
   short unstyled growth (<5mm), "beard" for full/styled
   growth, "mustache" or "goatee" for isolated styles. Pick
   "clean_shaven" for female-presenting avatars.

6. WARDROBE STYLE + SUMMARY: style is bucketed; summary is
   freeform 1-sentence. If the thumbnail crop hides the shirt
   entirely, describe what IS visible (collar, neckline).

7. BACKGROUND SETTING: "studio" for neutral seamless
   backgrounds. "indoor_home" for domestic interiors
   (kitchens, living rooms). "indoor_office" for work/
   professional interiors. "outdoor" for exterior scenes.
   "neutral" for solid-color / plain backdrops. "other" only
   when genuinely uncategorizable.

DEFENSIVE DEFAULTS: if the thumbnail is corrupted or the person
is not clearly visible, still emit a complete JSON object with
your best guesses across ALL fields and set confidence_note to
"thumbnail unclear — best-effort classification". Never emit an
incomplete object; never emit null for enum fields.

Return the JSON object and nothing else.`;
