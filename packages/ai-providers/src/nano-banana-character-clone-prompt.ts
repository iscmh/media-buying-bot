/**
 * Polish-28.0.0 Commit 64: Nano Banana Pro character-clone prompt.
 *
 * Model: `gemini-3-pro-image-preview` (aka "Nano Banana Pro").
 * Endpoint: same Gemini API as text/vision — the model ID string
 * routes to the image-generation head. Returns image as base64 in
 * `inline_data` on the response part.
 *
 * Contract: input is one source-ad reference frame + a persona
 * description extracted from the source ad's Gemini vision analysis.
 * Output is one persona-consistent reference PORTRAIT frame (head +
 * shoulders + relevant torso, framed for HeyGen Avatar IV
 * consumption).
 *
 * The prompt is deliberately STRUCTURED — a JSON-ish spec block
 * that Nano Banana Pro handles more reliably than freeform prose
 * (verified via internal tests + community reports). The reference
 * frame(s) are passed as additional `inline_data` parts in the
 * generateContent call so the model can carry gender/ethnicity/hair
 * /wardrobe from the source.
 *
 * Character consistency mechanic:
 *   - Nano Banana Pro accepts up to 14 reference images per call.
 *     Polish-28 uses ONE (a single source-ad frame extract) to keep
 *     the cost per generation deterministic at ~$0.13 (Gemini 3 Pro
 *     Image Preview retail: ~2K output tokens × $120/1M = $0.13).
 *   - The prompt tells the model to preserve identity from the
 *     reference but recompose into a clean UGC-portrait frame — no
 *     background clutter, no product hold-up, no gestures. Just the
 *     persona from the source ad in a neutral pose ready to be
 *     lip-synced by HeyGen Avatar IV.
 */

/**
 * Nano Banana Pro model ID. In `-preview` state as of Polish-28
 * — Google may bump the string; env-override is available via
 * NANO_BANANA_PRO_MODEL_ID so a rename doesn't require a redeploy.
 */
export const NANO_BANANA_PRO_DEFAULT_MODEL_ID = 'gemini-3-pro-image-preview';

/**
 * Fallback / MVP-tier model. Lighter, 3× cheaper (~$0.04/image),
 * still supports image-to-image + character consistency. Callers
 * can choose either at submit time; default is Pro per operator's
 * Phase-1 decision to prioritize character fidelity.
 */
export const NANO_BANANA_STANDARD_MODEL_ID = 'gemini-2.5-flash-image';

export function nanoBananaProModel(): string {
  const raw = process.env['NANO_BANANA_PRO_MODEL_ID']?.trim();
  return raw && raw.length > 0 ? raw : NANO_BANANA_PRO_DEFAULT_MODEL_ID;
}

/**
 * Nano Banana Pro character-clone prompt.
 *
 * The `personaDescription` argument is the freeform persona line
 * from `concepts.metadata.analysis.persona` (Gemini vision output
 * from analyze-concept) — e.g. "30s Latina woman, brown wavy hair
 * shoulder-length, casual burgundy sweater, warm expression".
 *
 * The generated JSON-ish spec block constrains the output to:
 *   - Head + upper torso framing (works for HeyGen Avatar IV)
 *   - Neutral studio-lit portrait (no product / setting distraction)
 *   - Direct camera gaze + closed relaxed mouth (baseline pose for
 *     lip-sync — Avatar IV animates from the closed-mouth reference)
 *   - Solid neutral background (transparent-adjacent light gray)
 *   - Sharp 1024×1024+ resolution
 */
/**
 * Polish-28.0.2 Commit 64.2 hotfix: shape-safe input coercion.
 *
 * The `analysis.persona` field emitted by the POLISH23_VISION_SYSTEM_
 * PROMPT is a structured Polish23Persona object:
 *
 *   { gender: 'male' | 'female' | 'ambiguous',
 *     age_range: '60s',
 *     ethnicity: 'white' | 'black' | 'asian' | ... ,
 *     look: 'Older gentleman with silver hair, warm expression, ...',
 *     voice_tone: 'Warm, gentle, sincere' }
 *
 * The persona-synthesizer fallback (Polish-26.0.6 Commit 61.6, used
 * when the UGC_DECONSTRUCTOR prompt fired for a Polish-23-shape
 * pipeline) also returns this same shape.
 *
 * flattenPersonaForClonePrompt accepts EITHER the object shape OR a
 * freeform string (for future-compat / degraded outputs). String
 * input passes through trimmed; object input renders as a compact
 * multi-line description that surfaces gender / age / ethnicity /
 * look for maximum character-clone fidelity.
 *
 * voice_tone is intentionally OMITTED — it's audio-related and
 * irrelevant to a visual portrait. Nano Banana Pro would only be
 * distracted by "warm, sincere" when generating a portrait.
 */
export function flattenPersonaForClonePrompt(persona: unknown): string {
  if (typeof persona === 'string') return persona.trim();
  if (persona && typeof persona === 'object') {
    const p = persona as {
      gender?: unknown;
      age_range?: unknown;
      ethnicity?: unknown;
      look?: unknown;
      // Some callers might pass the UGC_DECONSTRUCTOR shape here —
      // handle the `appearance` field too (worker's fallback path).
      appearance?: unknown;
    };
    const parts: string[] = [];
    if (typeof p.age_range === 'string' && p.age_range.trim()) {
      parts.push(`Age: ${p.age_range.trim()}`);
    }
    if (typeof p.gender === 'string' && p.gender.trim()) {
      parts.push(`Gender: ${p.gender.trim()}`);
    }
    if (typeof p.ethnicity === 'string' && p.ethnicity.trim()) {
      parts.push(`Ethnicity: ${p.ethnicity.trim()}`);
    }
    const lookText =
      typeof p.look === 'string' && p.look.trim()
        ? p.look.trim()
        : typeof p.appearance === 'string' && p.appearance.trim()
          ? p.appearance.trim()
          : '';
    if (lookText) parts.push(`Look: ${lookText}`);
    return parts.join('. ');
  }
  return '';
}

export function composeNanoBananaCharacterClonePrompt(
  personaDescription: string | Record<string, unknown>,
): string {
  const trimmedPersona = flattenPersonaForClonePrompt(personaDescription);
  return [
    'Generate a photorealistic head-and-upper-torso PORTRAIT of the person described',
    'below. The reference image attached shows the exact person to preserve — carry',
    'their identity (facial structure, gender, apparent age, ethnicity, hair color',
    'and cut, expression tone) into the new portrait. Do NOT preserve the reference',
    "image's background, wardrobe styling, or props — recompose entirely.",
    '',
    'PORTRAIT SPECIFICATION (JSON):',
    '{',
    '  "framing": "head and upper torso, chest-up, subject centered",',
    '  "camera_angle": "eye-level, straight-on, subject facing camera directly",',
    '  "expression": "neutral relaxed, mouth closed, lips gently together, slight',
    '  natural smile trace — this is the base frame for lip-sync so mouth MUST',
    '  be closed",',
    '  "gaze": "direct eye contact with the camera lens",',
    '  "posture": "shoulders squared to camera, no tilt, no gesture, hands not',
    '  visible in frame",',
    '  "wardrobe": "clean solid-color casual top (crew neck t-shirt, henley, or',
    '  simple crew sweater) — NO logos, patterns, jewelry, hats, sunglasses,',
    "  scarves, or lanyards. Wardrobe color chosen to complement the subject's",
    '  natural coloring without competing with skin tone",',
    '  "background": "smooth solid neutral studio gradient — warm light gray to',
    '  soft off-white, no texture, no shadow patterns, no scenery, no props,',
    '  no windows, no plants, no furniture",',
    '  "lighting": "soft even studio lighting, key light 45 degrees front-camera,',
    '  gentle fill, no harsh shadows, no color-cast, evenly lit face",',
    '  "resolution": "high-resolution photorealistic portrait, sharp facial',
    '  detail, minimum 1024x1024",',
    '  "aspect_ratio": "1:1"',
    '}',
    '',
    `PERSON TO PRESERVE (from source-ad vision analysis): ${trimmedPersona}`,
    '',
    'HARD CONSTRAINTS:',
    '- Preserve identity from the reference image (face, age, ethnicity, hair)',
    "- Preserve subject only — do NOT preserve the reference's background",
    '- Mouth MUST be closed / gently together — this frame drives lip-sync',
    '- No text, no logos, no watermarks, no captions overlaid on the image',
    '- No hands, arms visible, product hold-ups, or gestures',
    '- No sunglasses, hats, jewelry, or accessories that occlude the face',
    '- No props, no scenery, no background elements — solid neutral only',
    '- Photorealistic — do NOT stylize (no cartoon, no painterly, no filter)',
    '',
    'Emit ONE image matching the specification above.',
  ].join('\n');
}

/**
 * Suggested Gemini generationConfig for Nano Banana Pro portrait gen.
 * `responseModalities: ['IMAGE']` is REQUIRED for the image head to
 * activate — omitting it returns text. `imageConfig.aspectRatio: '1:1'`
 * pairs with the prompt's `"aspect_ratio": "1:1"` — HeyGen Avatar IV
 * crops/pads to 9:16 downstream anyway, but a square reference gives
 * the animation model the most upper-torso pixels to work from.
 */
export const NANO_BANANA_PRO_PORTRAIT_GENERATION_CONFIG = {
  responseModalities: ['IMAGE'] as const,
  imageConfig: { aspectRatio: '1:1' as const },
  // Slight nudge toward preserving-vs-inventing when a reference is
  // attached — Google's docs recommend 0.3-0.5 for consistency-anchored
  // generation. Kept as a constant so downstream tuning is one line.
  temperature: 0.4,
};
