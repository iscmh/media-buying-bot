/**
 * Polish-19.0.4: shared Nano Banana prompt directives. The two
 * constants below were iteratively tuned across Polish-9.x → 12.x
 * (UGC realism, anti-text, anti-b-roll). They previously lived inline
 * inside generate-kling-multi-clip-variants.ts; extracted here so the
 * Polish-19 Kling Avatar v2 worker can reuse them without a sibling-
 * file import, and so future pipelines have a clean shared source.
 *
 * The original file re-exports both names so the existing test suite
 * + Omni Flash worker imports keep working without churn.
 */

/**
 * Polish-11.2: hard image-side directive prepended to every Nano
 * Banana prompt. Polish-10.5 locked the Kling video prompt down on
 * captions/b-roll, but the image prompt was still leaking "lower-
 * third" / "caption" / "b-roll" language from the source-ad
 * deconstruction → Nano Banana baked captions into the first frame →
 * Kling animated the captions across every clip. Verified visually
 * on kling-frame-0 in production.
 */
export const IMAGE_UGC_HARD_DIRECTIVE = [
  'AMATEUR SMARTPHONE SELFIE PHOTO. Single character. Eye-level iPhone front camera shot. Vertical 9:16 portrait.',
  'PHOTOREALISTIC. Real human skin texture with pores. Natural lighting. NOT studio. NOT cinematic. NOT polished.',
  'ABSOLUTELY NO TEXT visible anywhere in the image. NO captions. NO subtitles. NO on-screen text. NO title cards. NO lower thirds. NO chyrons. NO text overlays. NO watermarks. NO logos. NO graphics. NO speech bubbles. NO printed text on objects.',
  'NO B-roll inset. NO picture-in-picture. NO multi-panel layout. NO product close-ups composited in. NO money close-ups. NO phone screenshots superimposed. NO insert shots.',
  'JUST the single character in the single environment described. Single clean clear photograph. Nothing else in frame.',
].join(' ');

/**
 * Polish-9.18: amateur-smartphone realism cues. Wraps every Nano
 * Banana prompt so any residual character-sheet / studio language
 * in the source manual gets overridden into single-subject single-
 * view UGC selfie mode.
 */
export const UGC_FRAMING = [
  'Single character, single view, NOT a character sheet, NOT multiple angles, NOT front/back/side views.',
  'AMATEUR SMARTPHONE SELFIE captured on an iPhone front camera in handheld vertical orientation. NOT professional photography, NOT studio lighting, NOT a stock photo.',
  'Camera: front-facing iPhone selfie at eye-level. Slight handheld micro-shake. Vertical 9:16 portrait.',
  'Photographic style: AMATEUR. Lighting is natural ambient indoor or natural daylight — NOT cinematic, NOT studio.',
  'SKIN: hyper-realistic pores, natural texture, subtle wrinkles, visible blemishes/freckles, NOT smooth, NOT airbrushed, NOT glossy, NOT plastic. Real human skin.',
  'Hair: natural, slightly imperfect, individual strands visible.',
  'Eyes: natural with subtle catchlights, NOT over-rendered, NOT symmetric AI eyes.',
  'Background: slightly out of focus, authentic indoor home, NOT a soundstage.',
  'ONLY the single character described, in the single scene described.',
].join(' ');

/**
 * Polish-19.0.4: single-line anti-celebrity guidance for the Kling
 * Avatar v2 pipeline. Distinct from the Polish-12.6
 * ANTI_CELEBRITY_NANO_BANANA_DIRECTIVE (long explicit celebrity
 * exclusion list, used by the Omni Flash worker where Gemini's
 * downstream PROMINENT_PEOPLE_FILTER is strict). Kling Avatar v2
 * animates a provided face rather than generating from scratch —
 * the heavy laundry list is unnecessary; one line of generic
 * guidance is the right scope.
 */
export const KLING_AVATAR_ANTI_CELEB_LINE =
  'The character must be a completely fictional, generic everyday person with no resemblance to any public figure (actor, musician, athlete, politician, influencer, etc.). Unremarkable, forgettable face.';

/**
 * Polish-19.0.8: structured character spec rewritten to match the
 * proven Polish-12.x JOHN pattern — the production-confirmed prompt
 * shape that reliably lands photoreal Nano Banana output. Polish-
 * 19.0.7 used an itemized-bullets shape ("- Hair: …\n- Eyes: …\n…")
 * that read as clinical to the model and still defaulted to 3D-
 * render output. The JOHN pattern lands "casting-director reference"
 * framing: three-view character sheet lead, naturalistic prose
 * blocks describing head / body / clothing as a continuous person
 * rather than disassembled features, the exact SKIN REALISM MANDATE
 * phrasing with three explicit ZERO anchors (NOT two), and one of
 * the anchors is "ZERO AI plastic-skin artifacts" — the directive
 * that explicitly fights the model's default aesthetic.
 *
 * Required: every field below. A Claude character-description step
 * in the worker produces a JSON payload matching this shape;
 * parseStructuredCharacter (worker-side) validates + returns it.
 */
export interface StructuredCharacter {
  /** Fictional first name — anchors the model toward a specific person. */
  name: string;
  /** Specific number, not a range — Nano Banana renders ranges as averages. */
  age: number;
  nationality: string;
  gender: 'male' | 'female' | 'nonbinary';
  /**
   * Naturalistic prose paragraph describing hair (length, color,
   * styling, thinning, grey, etc). NOT a bullet list. E.g.:
   * "Short, neatly side-combed grey hair, slightly thinning at the
   * temples."
   */
  hair_description: string;
  /**
   * Naturalistic prose paragraph describing the face — laugh lines,
   * crow's feet, jowls, age spots, eye color + crinkle lines —
   * flowing sentences, NOT itemized. E.g.:
   * "Soft jowls just beginning to form along his jawline, deep laugh
   * lines bracketing his mouth, scattered age spots across his
   * cheekbones. Warm brown eyes with genuine crinkle lines from
   * years of squinting in the sun."
   */
  face_description: string;
  /**
   * Naturalistic prose paragraph describing build / posture /
   * clothing as a single lived-in story. Must include posture cue
   * tied to character context (e.g. "the posture of a man used to
   * sitting on a sofa") and clothing wear detail ("slightly worn
   * at the collar — not new, not dirty").
   */
  body_posture_clothing: string;
  /**
   * Drives the SKIN REALISM MANDATE's stubble line. Use 'none' for
   * clean-shaven OR characters where stubble doesn't apply
   * (children, most women) — the stubble sentence is then omitted
   * entirely. Otherwise this colors the stubble shadow.
   */
  skin_color_for_stubble: 'grey' | 'brown' | 'black' | 'blonde' | 'red' | 'none';
  /**
   * Concrete role used in the closing identity assertion ("must look
   * like a real 62-year-old grandfather"). E.g.:
   * "grandfather", "mother", "retiree", "young professional",
   * "construction worker", "stay-at-home dad".
   */
  role_description: string;
  /**
   * Setting description — single paragraph, includes the light
   * source ("from a large bay window", "from an overhead kitchen
   * fixture") so the camera/setting close line can reference it.
   */
  setting_description: string;
}

/**
 * Polish-19.0.8: build the Kling Avatar v2 worker's Nano Banana
 * reference prompt from the structured character spec. Composition
 * follows the proven Polish-12.x JOHN pattern:
 *
 *   1. THREE-VIEW LEAD — "Photorealistic three-view character sheet,
 *      front view, side view, back view…" signals casting-director
 *      reference, not AI portrait.
 *   2. HEAD/FACE — naturalistic prose paragraph (hair + face desc).
 *   3. BODY/POSTURE/CLOTHING — single lived-in story paragraph.
 *   4. SKIN REALISM MANDATE — exact phrasing with the three explicit
 *      ZERO anchors ("ZERO beauty filters. ZERO skin smoothing.
 *      ZERO AI plastic-skin artifacts.") + the closing identity
 *      assertion ("must look like a real 62-year-old grandfather,
 *      not a model, not an actor, not an AI-generated character.").
 *   5. CAMERA/SETTING — single line tying together iPhone framing +
 *      the supplied setting description.
 *   6. IMAGE_UGC_HARD_DIRECTIVE + KLING_AVATAR_ANTI_CELEB_LINE —
 *      preserved at the tail for anti-text + anti-celeb reinforcement.
 *
 * The Polish-19.0.7 itemized-bullets composition is gone — only the
 * Kling Avatar v2 worker consumed the helper, and the bullet shape
 * was the active quality regression we're fixing here.
 */
export function buildKlingAvatarReferencePrompt(character: StructuredCharacter): string {
  const pronounSubject =
    character.gender === 'male' ? 'He' : character.gender === 'female' ? 'She' : 'They';
  const genderNoun =
    character.gender === 'male' ? 'man' : character.gender === 'female' ? 'woman' : 'person';

  // Block 1 — THREE-VIEW LEAD
  const lead =
    `Photorealistic three-view character sheet — front view, side view, back view — of a ` +
    `${character.age}-year-old ${character.nationality} ${genderNoun} named ${character.name.toUpperCase()}.`;

  // Block 2 — HEAD/FACE (naturalistic, NOT itemized)
  const headFace = `${character.hair_description} ${character.face_description}`;

  // Block 3 — BODY/POSTURE/CLOTHING (single paragraph)
  const bodyPostureClothing = character.body_posture_clothing;

  // Block 4 — SKIN REALISM MANDATE (the exact proven phrasing)
  const stubbleLine =
    character.skin_color_for_stubble === 'none'
      ? ''
      : ` Real ${character.skin_color_for_stubble} stubble shadow on upper lip and jaw from one day of missed shaving.`;
  const skinRealism =
    `SKIN REALISM MANDATE: Hyper-realistic unedited human skin. ` +
    `Visible pores, natural sebaceous texture on nose.${stubbleLine} ` +
    `Natural vellus hair on forearms. ` +
    `ZERO beauty filters. ZERO skin smoothing. ZERO AI plastic-skin artifacts. ` +
    `${pronounSubject} must look like a real ${character.age}-year-old ${character.role_description}, ` +
    `not a model, not an actor, not an AI-generated character.`;

  // Block 5 — CAMERA/SETTING (single line)
  const cameraSetting =
    `Shot on iPhone front camera, 9:16 vertical, natural daylight, slightly shaky handheld feel. ` +
    character.setting_description;

  return [
    lead,
    headFace,
    bodyPostureClothing,
    skinRealism,
    cameraSetting,
    IMAGE_UGC_HARD_DIRECTIVE,
    KLING_AVATAR_ANTI_CELEB_LINE,
  ].join('\n\n');
}
