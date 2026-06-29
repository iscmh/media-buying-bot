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
 * Polish-19.0.4: build the Kling Avatar v2 worker's Nano Banana
 * reference prompt. Composes the Polish-11.2 IMAGE_UGC_HARD_DIRECTIVE
 * (anti-text/captions/b-roll) and the Polish-9.18 UGC_FRAMING
 * (amateur-selfie realism) with a short character anchor and the
 * single-line anti-celeb guidance.
 *
 * `characterDescription` is optional — when omitted (no Claude-
 * produced character sheet, e.g. the simplified-form path generates
 * a script but no character manual), a generic everyperson stub is
 * used. The output stays photoreal, amateur-iPhone-selfie framed,
 * and free of celebrity resemblance regardless.
 */
export function buildKlingAvatarReferencePrompt(input?: { characterDescription?: string }): string {
  const character =
    input?.characterDescription?.trim() ||
    'A single fictional everyday person, 25-50 years old, casual everyday clothing, neutral facial expression.';
  return [
    IMAGE_UGC_HARD_DIRECTIVE,
    UGC_FRAMING,
    `Character: ${character}`,
    'CRITICAL: ONE single frame, ONE camera angle. NO text, NO captions, NO overlays anywhere in the image. NOT a reference sheet. NOT multiple poses.',
    KLING_AVATAR_ANTI_CELEB_LINE,
  ].join('\n\n');
}
