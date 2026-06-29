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
 * Polish-19.0.7: structured character spec consumed by
 * buildKlingAvatarReferencePrompt. The fields below mirror the
 * proven manual prompt pattern that lands actual photoreal iPhone-
 * selfie output from Nano Banana — itemized physical features with
 * deliberate asymmetry / imperfection anchors, ZERO-airbrushing
 * framing, and a specific setting. The pre-Polish-19.0.7 freeform
 * string input let Nano Banana default to stylized 3D-render output
 * because the prompt gave too much interpretive latitude.
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
   * One-line archetype framing (e.g. "Generic suburban grandmother
   * appearance.") — caps the model's interpretive freedom up front
   * before the itemized features land.
   */
  archetype: string;
  hair: {
    color: string;
    length: string;
    cut: string;
    texture: string;
    /** Must contain "messy" / "loose" / "asymmetric" or equivalent. */
    styling: string;
  };
  eyes: {
    color: string;
    /** Required imperfection anchor (e.g. "one eyelid drooping slightly more"). */
    asymmetry: string;
    crows_feet: string;
    bags: string;
  };
  /** Nose description with at least one imperfection (width, bump, asymmetry). */
  nose: string;
  /** Lip thickness + asymmetry + resting expression. */
  mouth: string;
  /** Must explicitly include "NOT chiseled, NOT model-shaped" or equivalent. */
  jaw_and_face_shape: string;
  skin_imperfections: {
    /** Required field — should describe visible pores. */
    pores: string;
    age_spots: string;
    redness: string;
    capillaries: string;
    /** Required ZERO-airbrushing anchor (e.g. "ZERO airbrushing"). */
    anchor: string;
  };
  /** Specific items + casual/lived-in framing. */
  clothing: string;
  setting: {
    room_type: string;
    /** 2-3 specific detail items (e.g. ["beige sofa behind her", "side table with coffee mug"]). */
    details: string[];
    lighting: string;
  };
}

/**
 * Polish-19.0.7: build the Kling Avatar v2 worker's Nano Banana
 * reference prompt from a structured character spec. Composition
 * follows the proven manual prompt pattern: photoreal lead →
 * itemized physical features with asymmetry anchors → setting →
 * ZERO-airbrushing skin block → iPhone-selfie close. The Polish-
 * 11.2 IMAGE_UGC_HARD_DIRECTIVE + Polish-19.0.4 anti-celeb line
 * remain at the tail as anti-text/anti-celeb reinforcement (and
 * for back-compat with the Polish-11.2 test pins that check
 * IMAGE_UGC_HARD_DIRECTIVE's presence in output).
 *
 * The pre-19.0.7 freeform `characterDescription` signature is gone —
 * any caller passing a string instead of a StructuredCharacter is
 * a type error at the call site. Only the Kling Avatar v2 worker
 * consumed the helper; other Polish-12.x callers use the underlying
 * directives directly, not this composer.
 */
export function buildKlingAvatarReferencePrompt(character: StructuredCharacter): string {
  const pronounSubject =
    character.gender === 'male' ? 'He' : character.gender === 'female' ? 'She' : 'They';

  const featureBullets = [
    `- Hair: ${[
      character.hair.color,
      character.hair.length,
      character.hair.cut,
      character.hair.texture,
      character.hair.styling,
    ]
      .filter(Boolean)
      .join(', ')}`,
    `- Eyes: ${character.eyes.color}, ${character.eyes.asymmetry}, ${character.eyes.crows_feet}, ${character.eyes.bags}`,
    `- Nose: ${character.nose}`,
    `- Mouth: ${character.mouth}`,
    `- Jaw and face shape: ${character.jaw_and_face_shape}`,
    `- Wearing ${character.clothing}`,
  ].join('\n');

  const skinImperfections = [
    character.skin_imperfections.pores,
    character.skin_imperfections.age_spots,
    character.skin_imperfections.redness,
    character.skin_imperfections.capillaries,
  ]
    .filter(Boolean)
    .join(', ');

  const settingDetails = character.setting.details
    .filter((d) => d && d.trim().length > 0)
    .join(', ');

  const lead =
    `PHOTOREALISTIC PHOTOGRAPH. Vertical iPhone selfie of a fictional ${character.age}-year-old ` +
    `${character.nationality} ${character.gender === 'nonbinary' ? 'person' : character.gender} ` +
    `named ${character.name}. ${character.archetype}`;

  const featuresBlock = `PHYSICAL FEATURES (deliberately asymmetric and ordinary):\n${featureBullets}`;

  const settingBlock =
    `${pronounSubject} is in ${character.setting.room_type}` +
    (settingDetails ? ` — ${settingDetails}` : '') +
    `. ${character.setting.lighting}.`;

  const skinBlock =
    `SKIN REALISM: Real ${character.age}-year-old skin — ${skinImperfections}. ` +
    `${character.skin_imperfections.anchor}. ZERO airbrushing, ZERO beauty filter, ZERO smoothing.`;

  const close =
    'Shot on iPhone front camera, 9:16 vertical, natural daylight, slightly shaky handheld feel.';

  return [
    lead,
    featuresBlock,
    settingBlock,
    skinBlock,
    close,
    IMAGE_UGC_HARD_DIRECTIVE,
    KLING_AVATAR_ANTI_CELEB_LINE,
  ].join('\n\n');
}
