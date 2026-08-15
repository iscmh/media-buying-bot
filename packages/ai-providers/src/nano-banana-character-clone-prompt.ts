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
    'Generate a photorealistic UGC-STYLE SELFIE of the person described below.',
    'The reference image attached shows the exact person to preserve — carry',
    'their identity (facial structure, gender, apparent age, ethnicity, hair',
    'color and cut, expression tone) into the new portrait. Do NOT preserve the',
    "reference image's background, wardrobe, captions, text overlays, watermarks,",
    'or any environmental elements — recompose entirely into a fresh casual',
    'UGC-content-creator context.',
    '',
    'CRITICAL AESTHETIC — this must look like a REAL PERSON filming themselves',
    'on their iPhone for a TikTok / Instagram Reels post. NOT a studio headshot,',
    'NOT professional photography, NOT an AI-generated avatar. Think authentic',
    'creator content — imperfect lighting, real skin texture with visible pores',
    'and minor blemishes, natural home environment. If it looks polished or',
    'stylized, it is WRONG.',
    '',
    'PORTRAIT SPECIFICATION (JSON):',
    '{',
    '  "framing": "MEDIUM-WIDE SHOT — head + full torso + hands/arms visible',
    "  at the bottom of the frame. Subject's face takes up NO MORE than ~35%",
    '  of the frame HEIGHT. Substantial headroom (10-15% empty above head) and',
    '  side room (subject occupies center ~60% of frame width). This is a',
    '  medium selfie shot, NOT a tight close-up. HeyGen Avatar IV will zoom',
    '  and reframe the face during lip-sync, so the input MUST leave breathing',
    '  room around the subject or the output will be uncomfortably close",',
    '  "camera": "iPhone-style front-camera selfie perspective — subject holds',
    '  phone at arm-length distance (arm fully extended), NOT close to face.',
    '  Mildly wide (~24mm equiv), candid amateur composition, mild lens',
    '  distortion typical of phone selfies",',
    '  "lighting": "natural indoor lighting — soft window light from one side,',
    '  OR overhead ambient home lighting, OR bathroom vanity light. Imperfect,',
    '  slightly uneven. NO studio softbox, NO ring light, NO professional key,',
    '  NO evenly-lit-face beauty lighting",',
    '  "setting": "real casual home interior visible behind the subject — a',
    '  bedroom wall with soft decor, a living room corner, a kitchen background,',
    '  a home office, a car interior, or a bathroom mirror shot. Casually',
    '  lived-in / cluttered / real. NOT a plain studio backdrop, NOT a solid',
    "  color, NOT a green screen. Choose a setting matching the subject's",
    '  apparent demographic",',
    '  "wardrobe": "casual everyday clothing appropriate for the subject —',
    '  hoodie, plain t-shirt, casual sweater, tank top, or loungewear.',
    '  Non-formal, no visible brand logos or graphic prints",',
    '  "skin": "photorealistic REAL skin — visible pores, small imperfections,',
    '  natural color variation across face, unretouched. NO smoothing, NO',
    '  airbrush, NO beauty-mode filter",',
    '  "expression": "neutral relaxed, mouth CLOSED, lips gently pressed together',
    '  — this frame drives HeyGen Avatar IV lip-sync so mouth MUST be closed",',
    '  "gaze": "direct eye contact with the camera lens",',
    '  "resolution": "high-resolution photorealistic, sharp facial detail",',
    '  "aspect_ratio": "9:16 vertical, phone-native"',
    '}',
    '',
    `PERSON TO PRESERVE (from source-ad vision analysis): ${trimmedPersona}`,
    '',
    'HARD CONSTRAINTS:',
    '- Preserve identity from the reference (face, age, ethnicity, hair)',
    "- Do NOT preserve the reference's background, captions, text, or setting",
    '- Mouth MUST be closed / gently together — this frame drives lip-sync',
    '- MEDIUM-WIDE FRAMING — face NO more than ~35% of frame height; leave',
    '  headroom above (10-15% empty) and side room. NOT a tight portrait.',
    '  HeyGen zooms during lip-sync; a tight input becomes an uncomfortable output.',
    '- Show hands / arms at bottom of frame (holding phone / at chest / relaxed at',
    '  sides). Fine to see; do NOT crop them out.',
    '- No text, no logos, no watermarks, no captions overlaid on the image',
    '- No product hold-ups in front of face, no gestures across face',
    '- No sunglasses, hats, or accessories that occlude the face',
    '- Photorealistic amateur UGC aesthetic — NOT studio, NOT stylized, NOT AI-avatar',
    '- Real home setting must be visible behind subject — NOT a solid color background',
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
