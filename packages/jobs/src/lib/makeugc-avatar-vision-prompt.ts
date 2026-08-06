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
// Polish-26.0.10 Commit 62: coercion layer + diagnostic parser
// ---------------------------------------------------------------
//
// WHY: HeyGen sync circuit-breaker tripped at chunk 44 after 20
// consecutive "JSON did not match schema" failures. Two root
// problems:
//
//   1. Strict Zod rejects any Gemini output that isn't EXACTLY in
//      the enum. Real drift observed at other vision endpoints:
//      "south_asian" for ethnicity, "grey" for hair_color, numeric
//      age instead of bucket, "office" for background_setting.
//      These are equivalent classifications the matcher would
//      have accepted — Zod threw them away.
//
//   2. Failure signature was the CONSTANT string
//      "JSON did not match schema" for all schema-fails. Twenty
//      different drift patterns collapsed to one signature and
//      tripped the circuit-breaker in 20 chunks, artificially
//      capping the pool at 422 avatars.
//
// Fix: try strict-parse first; on fail, run coercion mapping table
// (equivalent labels); on still-fail, return a DIAGNOSTIC with
// per-field failure detail so the caller can emit a signature that
// splits by drift pattern.
//
// Coercion is CONSERVATIVE — only maps values that are unambiguous
// equivalents to enum members (spelling variants, plurals, common
// synonyms). Never invents a bucket for genuinely unknown values —
// those still fail, so the operator sees them in diagnostics.

const AGE_BUCKET_ALIASES: Record<string, MakeugcAgeBucket> = {
  '10s': '20s',
  teen: '20s',
  teens: '20s',
  teenager: '20s',
  young: '20s',
  twenties: '20s',
  thirties: '30s',
  forties: '40s',
  fifties: '50s',
  sixties: '60s',
  seventies: '70s',
  eighties: '80s+',
  'middle-aged': '40s',
  middle_aged: '40s',
  'middle aged': '40s',
  senior: '70s',
  elderly: '70s',
  '70+': '70s',
  '80+': '80s+',
  '90+': '80s+',
};

const ETHNICITY_ALIASES: Record<string, MakeugcEthnicity> = {
  caucasian: 'white',
  european: 'white',
  'south asian': 'asian',
  south_asian: 'asian',
  'south-asian': 'asian',
  'east asian': 'asian',
  east_asian: 'asian',
  'east-asian': 'asian',
  'southeast asian': 'asian',
  southeast_asian: 'asian',
  indian: 'asian',
  chinese: 'asian',
  japanese: 'asian',
  korean: 'asian',
  vietnamese: 'asian',
  filipino: 'asian',
  'african american': 'black',
  african_american: 'black',
  'african-american': 'black',
  african: 'black',
  'hispanic-latino': 'hispanic',
  'hispanic/latino': 'hispanic',
  latinx: 'latino',
  latina: 'latino',
  arab: 'middle_eastern',
  'middle eastern': 'middle_eastern',
  'middle-eastern': 'middle_eastern',
  persian: 'middle_eastern',
  jewish: 'middle_eastern',
  multiracial: 'mixed',
  biracial: 'mixed',
  'mixed race': 'mixed',
  mixed_race: 'mixed',
  undetermined: 'other',
  unknown: 'other',
  ambiguous: 'other',
};

const HAIR_COLOR_ALIASES: Record<string, MakeugcHairColor> = {
  grey: 'gray',
  silver: 'gray',
  'salt and pepper': 'gray',
  'salt-and-pepper': 'gray',
  salt_and_pepper: 'gray',
  blond: 'blonde',
  auburn: 'red',
  ginger: 'red',
  strawberry: 'red',
  'strawberry blonde': 'blonde',
  brunette: 'brown',
  dark: 'brown',
  'dark brown': 'brown',
  'light brown': 'brown',
  chestnut: 'brown',
  none: 'bald',
  hairless: 'bald',
  shaved: 'bald',
  unknown: 'other',
};

const FACIAL_HAIR_ALIASES: Record<string, MakeugcFacialHair> = {
  none: 'clean_shaven',
  no: 'clean_shaven',
  'no facial hair': 'clean_shaven',
  clean: 'clean_shaven',
  'clean shaven': 'clean_shaven',
  'clean-shaven': 'clean_shaven',
  cleanshaven: 'clean_shaven',
  shaven: 'clean_shaven',
  moustache: 'mustache',
  'full beard': 'beard',
  'short beard': 'beard',
  bearded: 'beard',
  '5 o clock shadow': 'stubble',
  "5 o'clock shadow": 'stubble',
  five_o_clock_shadow: 'stubble',
  scruff: 'stubble',
  scruffy: 'stubble',
  soul_patch: 'goatee',
  'soul patch': 'goatee',
  vandyke: 'goatee',
};

const WARDROBE_STYLE_ALIASES: Record<string, MakeugcWardrobeStyle> = {
  'business casual': 'business_casual',
  'business-casual': 'business_casual',
  smart: 'business_casual',
  'smart casual': 'business_casual',
  'smart-casual': 'business_casual',
  business: 'formal',
  professional: 'formal',
  suit: 'formal',
  sporty: 'athletic',
  sportswear: 'athletic',
  activewear: 'athletic',
  workout: 'athletic',
  gym: 'athletic',
  artistic: 'creative',
  bohemian: 'creative',
  eclectic: 'creative',
  streetwear: 'casual',
  everyday: 'casual',
};

const BACKGROUND_ALIASES: Record<string, MakeugcBackgroundSetting> = {
  office: 'indoor_office',
  workplace: 'indoor_office',
  desk: 'indoor_office',
  'indoor office': 'indoor_office',
  home: 'indoor_home',
  house: 'indoor_home',
  apartment: 'indoor_home',
  kitchen: 'indoor_home',
  'living room': 'indoor_home',
  living_room: 'indoor_home',
  livingroom: 'indoor_home',
  bedroom: 'indoor_home',
  bathroom: 'indoor_home',
  domestic: 'indoor_home',
  interior: 'indoor_home',
  indoor: 'indoor_home',
  'indoor home': 'indoor_home',
  outside: 'outdoor',
  exterior: 'outdoor',
  nature: 'outdoor',
  street: 'outdoor',
  park: 'outdoor',
  garden: 'outdoor',
  beach: 'outdoor',
  plain: 'neutral',
  solid_color: 'neutral',
  'solid color': 'neutral',
  blank: 'neutral',
  'white background': 'neutral',
  green_screen: 'studio',
  greenscreen: 'studio',
  'green screen': 'studio',
  seamless: 'studio',
};

function normalizeKey(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().trim() : '';
}

function coerceAgeBucket(raw: unknown): { value: MakeugcAgeBucket | null; note: string | null } {
  const key = normalizeKey(raw);
  if (!key) return { value: null, note: 'age_bucket: missing/non-string' };
  if ((MAKEUGC_AGE_BUCKETS as readonly string[]).includes(key)) {
    return { value: key as MakeugcAgeBucket, note: null };
  }
  const alias = AGE_BUCKET_ALIASES[key];
  if (alias) return { value: alias, note: `age_bucket: '${key}' -> '${alias}'` };
  const numMatch = key.match(/^\d{1,3}$/);
  if (numMatch) {
    const n = Number(key);
    if (n >= 15 && n < 90) {
      const decade = Math.floor(n / 10) * 10;
      const bucket: MakeugcAgeBucket = decade >= 80 ? '80s+' : (`${decade}s` as MakeugcAgeBucket);
      if ((MAKEUGC_AGE_BUCKETS as readonly string[]).includes(bucket)) {
        return { value: bucket, note: `age_bucket: numeric ${n} -> '${bucket}'` };
      }
    }
  }
  const rangeMatch = key.match(/^(\d{1,3})\s*[-\s]\s*(\d{1,3})$/);
  if (rangeMatch) {
    const lo = Number(rangeMatch[1]);
    if (lo >= 15 && lo < 90) {
      const decade = Math.floor(lo / 10) * 10;
      const bucket: MakeugcAgeBucket = decade >= 80 ? '80s+' : (`${decade}s` as MakeugcAgeBucket);
      if ((MAKEUGC_AGE_BUCKETS as readonly string[]).includes(bucket)) {
        return { value: bucket, note: `age_bucket: range '${key}' -> '${bucket}'` };
      }
    }
  }
  return { value: null, note: `age_bucket: '${key}' not in enum + no alias` };
}

function coerceFromAliases<T extends string>(
  raw: unknown,
  enumMembers: readonly T[],
  aliases: Record<string, T>,
  fieldName: string,
): { value: T | null; note: string | null } {
  const key = normalizeKey(raw);
  if (!key) return { value: null, note: `${fieldName}: missing/non-string` };
  if ((enumMembers as readonly string[]).includes(key)) return { value: key as T, note: null };
  const alias = aliases[key];
  if (alias) return { value: alias, note: `${fieldName}: '${key}' -> '${alias}'` };
  return { value: null, note: `${fieldName}: '${key}' not in enum + no alias` };
}

function coerceFreeformString(
  raw: unknown,
  fieldName: string,
  minLen: number,
  maxLen: number,
  fallback: string | null,
): { value: string | null; note: string | null } {
  if (typeof raw !== 'string') {
    if (fallback !== null)
      return { value: fallback, note: `${fieldName}: non-string -> fallback '${fallback}'` };
    return { value: null, note: `${fieldName}: non-string, no fallback` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (fallback !== null)
      return { value: fallback, note: `${fieldName}: empty -> fallback '${fallback}'` };
    return { value: null, note: `${fieldName}: empty, no fallback` };
  }
  if (trimmed.length < minLen)
    return { value: null, note: `${fieldName}: too short (${trimmed.length} < ${minLen})` };
  if (trimmed.length > maxLen) {
    return {
      value: trimmed.slice(0, maxLen),
      note: `${fieldName}: truncated ${trimmed.length}->${maxLen}`,
    };
  }
  return { value: trimmed, note: null };
}

export interface MakeugcAvatarVisionCoercionResult {
  analysis: MakeugcAvatarVisionAnalysis;
  coercionsApplied: string[];
}

export interface MakeugcAvatarVisionParseFailure {
  /** Human-readable summary combining all field-level failures. */
  reason: string;
  /** Compact signature for circuit-breaker de-duplication. Splits
   *  naturally by which field(s) drifted vs by identity. */
  signature: string;
  /** Every field-level issue (both coercions attempted and hard fails). */
  fieldIssues: string[];
  /** First ~400 chars of the raw JSON that failed, for the diagnostic log. */
  rawSnapshot: string;
}

export type MakeugcAvatarVisionParseResult =
  | { ok: true; analysis: MakeugcAvatarVisionAnalysis; coercionsApplied: string[] }
  | { ok: false; failure: MakeugcAvatarVisionParseFailure };

/**
 * Diagnostic parser: strict-parse first, then coerce, then hard-fail
 * with a per-field signature. Consumed by refresh-heygen-avatar-index
 * so schema-fails split into distinct circuit-breaker signatures
 * (one per drift pattern) instead of collapsing to one constant.
 */
export function parseMakeugcAvatarVisionAnalysisWithDiagnostics(
  raw: unknown,
): MakeugcAvatarVisionParseResult {
  const strict = MakeugcAvatarVisionAnalysisSchema.safeParse(raw);
  if (strict.success) {
    return { ok: true, analysis: strict.data, coercionsApplied: [] };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      failure: {
        reason: 'raw response is not a JSON object',
        signature: 'schema:not-object',
        fieldIssues: [`raw type: ${Array.isArray(raw) ? 'array' : typeof raw}`],
        rawSnapshot: JSON.stringify(raw).slice(0, 400),
      },
    };
  }
  const r = raw as Record<string, unknown>;

  const coercions: string[] = [];
  const fieldIssues: string[] = [];
  const hardFailFields: string[] = [];

  const ageBucket = coerceAgeBucket(r['age_bucket']);
  if (ageBucket.note) (ageBucket.value ? coercions : fieldIssues).push(ageBucket.note);
  if (!ageBucket.value) hardFailFields.push('age_bucket');

  const ethnicity = coerceFromAliases(
    r['ethnicity'],
    MAKEUGC_ETHNICITIES,
    ETHNICITY_ALIASES,
    'ethnicity',
  );
  if (ethnicity.note) (ethnicity.value ? coercions : fieldIssues).push(ethnicity.note);
  if (!ethnicity.value) hardFailFields.push('ethnicity');

  const hairColor = coerceFromAliases(
    r['hair_color'],
    MAKEUGC_HAIR_COLORS,
    HAIR_COLOR_ALIASES,
    'hair_color',
  );
  if (hairColor.note) (hairColor.value ? coercions : fieldIssues).push(hairColor.note);
  if (!hairColor.value) hardFailFields.push('hair_color');

  const hairStyle = coerceFreeformString(r['hair_style'], 'hair_style', 1, 80, 'unspecified');
  if (hairStyle.note) (hairStyle.value ? coercions : fieldIssues).push(hairStyle.note);
  if (!hairStyle.value) hardFailFields.push('hair_style');

  const facialHair = coerceFromAliases(
    r['facial_hair'],
    MAKEUGC_FACIAL_HAIRS,
    FACIAL_HAIR_ALIASES,
    'facial_hair',
  );
  if (facialHair.note) (facialHair.value ? coercions : fieldIssues).push(facialHair.note);
  if (!facialHair.value) hardFailFields.push('facial_hair');

  const wardrobeStyle = coerceFromAliases(
    r['wardrobe_style'],
    MAKEUGC_WARDROBE_STYLES,
    WARDROBE_STYLE_ALIASES,
    'wardrobe_style',
  );
  if (wardrobeStyle.note) (wardrobeStyle.value ? coercions : fieldIssues).push(wardrobeStyle.note);
  if (!wardrobeStyle.value) hardFailFields.push('wardrobe_style');

  const wardrobeSummary = coerceFreeformString(
    r['wardrobe_summary'],
    'wardrobe_summary',
    1,
    200,
    'unspecified',
  );
  if (wardrobeSummary.note)
    (wardrobeSummary.value ? coercions : fieldIssues).push(wardrobeSummary.note);
  if (!wardrobeSummary.value) hardFailFields.push('wardrobe_summary');

  const backgroundSetting = coerceFromAliases(
    r['background_setting'],
    MAKEUGC_BACKGROUND_SETTINGS,
    BACKGROUND_ALIASES,
    'background_setting',
  );
  if (backgroundSetting.note)
    (backgroundSetting.value ? coercions : fieldIssues).push(backgroundSetting.note);
  if (!backgroundSetting.value) hardFailFields.push('background_setting');

  // confidence_note: always coercible. Empty string when missing.
  let confidenceNote = '';
  if (typeof r['confidence_note'] === 'string') {
    confidenceNote = (r['confidence_note'] as string).slice(0, 400);
  } else if (r['confidence_note'] != null) {
    coercions.push(`confidence_note: non-string coerced to ''`);
  }

  if (hardFailFields.length > 0) {
    const sig = `schema:${hardFailFields.sort().join(',')}`;
    return {
      ok: false,
      failure: {
        reason: `cannot coerce required field(s): ${hardFailFields.join(', ')}`,
        signature: sig,
        fieldIssues,
        rawSnapshot: JSON.stringify(raw).slice(0, 400),
      },
    };
  }

  const analysis: MakeugcAvatarVisionAnalysis = {
    age_bucket: ageBucket.value!,
    ethnicity: ethnicity.value!,
    hair_color: hairColor.value!,
    hair_style: hairStyle.value!,
    facial_hair: facialHair.value!,
    wardrobe_style: wardrobeStyle.value!,
    wardrobe_summary: wardrobeSummary.value!,
    background_setting: backgroundSetting.value!,
    confidence_note: confidenceNote,
  };
  const final = MakeugcAvatarVisionAnalysisSchema.safeParse(analysis);
  if (!final.success) {
    return {
      ok: false,
      failure: {
        reason: `post-coercion Zod re-parse failed: ${final.error.issues.map((i) => i.path.join('.')).join(',')}`,
        signature: `schema:post-coerce-fail:${final.error.issues
          .map((i) => i.path.join('.'))
          .sort()
          .join(',')}`,
        fieldIssues: [
          ...fieldIssues,
          ...final.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        ],
        rawSnapshot: JSON.stringify(raw).slice(0, 400),
      },
    };
  }
  return { ok: true, analysis: final.data, coercionsApplied: coercions };
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
