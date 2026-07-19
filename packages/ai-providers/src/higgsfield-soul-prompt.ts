import type { CharacterLock } from '@mbb/shared';

/**
 * Polish-23 Commit 1: compose the Higgsfield Soul reference-image
 * prompt from a locked-in `CharacterLock` using the Polish-21.0.7
 * Linda 7-block pattern VERBATIM. The output goes into the
 * `prompt` field of a WaveSpeedAI Higgsfield Soul submit call.
 *
 * Why re-implement instead of importing packages/jobs helper:
 *
 *   The Polish-21.0.7 `composeNanoBananaCharacterPrompt` in
 *   packages/jobs/src/functions/generate-video-variant.ts is the
 *   source of truth for the Linda pattern text. Polish-23 Commit 5
 *   will delete that file alongside the whole Hedra/ElevenLabs
 *   stack. Copying the text verbatim into this ai-providers-owned
 *   module — with a `word-for-word text pin` test — keeps the
 *   Polish-23 pipeline self-contained AND keeps a per-word test
 *   pin that catches any accidental drift while the two anchors
 *   coexist. When Commit 5 deletes the Polish-21 helper, the
 *   Polish-23 anchor stays.
 *
 * Text anchors (all pinned by tests):
 *   1. Vertical iPhone selfie lead (fictional + demographic hint)
 *   2. PHYSICAL FEATURES (deliberately asymmetric and ordinary) —
 *      itemized bullets with specific imperfections
 *   3. Setting paragraph
 *   4. SKIN REALISM MANDATE — the three ZERO clauses
 *      (ZERO airbrushing. ZERO beauty filters. ZERO skin smoothing.
 *      ZERO AI plastic-skin artifacts.) preserved word-for-word
 *   5. CRITICAL ANTI-CELEBRITY DIRECTIVE — named examples +
 *      "anonymous, not attractive" reframe + regenerate self-check
 *   6. Camera / setting anchor (iPhone front camera, 9:16 vertical)
 *   7. Anti-AI directive tail (verbatim Kling 3.0 guide anchor)
 *
 * Any accidental rewrite that softens the ZERO clauses, drops the
 * ANONYMOUS-not-ATTRACTIVE reframe, or removes the celebrity
 * examples silently degrades Higgsfield Soul output back toward the
 * AI-CGI stock-photo aesthetic Polish-21.0.5 explicitly hardened
 * against.
 */
export function composeHiggsfieldSoulReferencePrompt(lock: CharacterLock): string {
  const {
    name,
    age,
    nationality,
    gender,
    demographic_role,
    hair_bullet,
    eye_asymmetry_bullet,
    nose_bullet,
    mouth_bullet,
    eye_color_and_age_detail,
    jaw_bullet,
    face_shape_bullet,
    clothing_bullet,
    setting_paragraph,
    skin_age_appropriate_detail,
    skin_color_for_stubble,
    anti_celeb_actress_examples,
    anti_celeb_news_examples,
    anti_celeb_politician_examples,
    body_invariant_bullet,
    setting_invariant_bullet,
  } = lock;
  const pronoun = gender === 'female' ? 'She' : 'He';
  const objectPronoun = gender === 'female' ? 'her' : 'him';
  const stubbleClause =
    skin_color_for_stubble === 'none'
      ? ''
      : ` Real ${skin_color_for_stubble} stubble shadow on upper lip and jaw from one day of missed shaving.`;

  // Block 1 — Linda selfie lead.
  // Polish-23 Commit 3.0.25: prefixed with "Hyper-realistic,
  // unretouched," so Higgsfield Soul dials up photorealism +
  // suppresses the airbrushed-selfie AI attractor. Followed by
  // a REFERENCE ANCHOR line that tells the downstream Veo pipeline
  // to treat this exact image as the character lock — same phrasing
  // as the per-clip CHARACTER LOCK prefix so both prompts pull in
  // the same direction.
  const block1_selfieLead =
    `Photorealistic vertical iPhone selfie of a fictional ${age}-year-old ${nationality} ${gender} named ${name}. ` +
    `Generic ${demographic_role} appearance. ` +
    `Hyper-realistic and unretouched — every physical feature must render exactly as specified below. ` +
    `This reference image will be the CHARACTER LOCK anchor for downstream Veo clips, so the video pipeline can match it verbatim.`;

  // Block 2 — PHYSICAL FEATURES (itemized bullets, deliberately
  // asymmetric). Bullets render sharper on image-to-image models
  // than paragraphs; the anti-generic imperfection stays intact
  // instead of averaging out.
  const block2_physicalFeatures =
    `PHYSICAL FEATURES (deliberately asymmetric and ordinary):\n` +
    `- ${hair_bullet}\n` +
    `- ${eye_asymmetry_bullet}\n` +
    `- ${nose_bullet}\n` +
    `- ${mouth_bullet}\n` +
    `- ${eye_color_and_age_detail}\n` +
    `- ${jaw_bullet}\n` +
    `- ${face_shape_bullet}\n` +
    `- Clothing: ${clothing_bullet}\n` +
    // Polish-23 Commit 3.0.17: body + setting invariant anchors
    // now seeded into the Higgsfield Soul reference PNG itself so
    // downstream Veo has consistent proportions + composition to
    // lock onto. First real end-to-end run showed body-shape
    // drift clip-to-clip; anchoring at the seed image is the
    // highest-leverage prevention.
    `BODY INVARIANT: ${body_invariant_bullet}\n` +
    `SETTING INVARIANT: ${setting_invariant_bullet}`;

  // Block 3 — Setting.
  const block3_setting = setting_paragraph;

  // Block 4 — SKIN REALISM MANDATE. Preserves the Polish-21.0.5
  // three ZERO anchors verbatim (ZERO airbrushing. ZERO beauty
  // filters. ZERO skin smoothing. ZERO AI plastic-skin artifacts.)
  // AND adds the Linda-shaped age-appropriate detail line.
  const block4_skinRealism =
    `SKIN REALISM MANDATE: Real ${age}-year-old skin — visible pores, natural sebaceous texture on nose, ${skin_age_appropriate_detail}, slight redness on cheekbones.${stubbleClause} Natural vellus hair on forearms. ` +
    `ZERO airbrushing. ZERO beauty filters. ZERO skin smoothing. ZERO AI plastic-skin artifacts. ` +
    `${pronoun} must look like a real ${age}-year-old ${demographic_role}, not a model, not an actor, ` +
    `not an AI-generated character.`;

  // Block 5 — CRITICAL ANTI-CELEBRITY DIRECTIVE. Steers Higgsfield
  // Soul away from famous-face attractors with named examples +
  // the "anonymous, not attractive" reframe + regenerate self-check.
  const actressList = anti_celeb_actress_examples.join(', ');
  const newsList = anti_celeb_news_examples.join(', ');
  const politicianList = anti_celeb_politician_examples.join(', ');
  const block5_antiCelebrity =
    `CRITICAL ANTI-CELEBRITY DIRECTIVE: The face must be DELIBERATELY GENERIC and FORGETTABLE. The face must NOT resemble:\n` +
    `- ANY actress (${actressList})\n` +
    `- ANY news anchor or talk show host (${newsList})\n` +
    `- ANY political figure or spouse (${politicianList})\n` +
    `- ANY famous ${gender} of the ~${age}-year-old bracket, living or dead.\n\n` +
    `The face should look like a RANDOM ${demographic_role}: 'the kind of face where you'd say I think I've seen ${objectPronoun} at the grocery store but you couldn't pick ${objectPronoun} out of a lineup.' Slightly asymmetric, ordinary features, no 'TV polish.'\n\n` +
    `Aim for ANONYMOUS, not ATTRACTIVE. The face should be intentionally unremarkable. If the face looks like a TV ${demographic_role} character, regenerate. The target is 'real human you'd walk past on the street and forget.'`;

  // Block 6 — Camera + framing + lighting anchor.
  // Polish-23 Commit 3.0.25: extended with explicit FRAMING and
  // LIGHTING sub-anchors. Downstream Veo clips need a REPRODUCIBLE
  // reference composition — same crop, same light direction, no
  // harsh shadows — so per-clip drift doesn't compound.
  const block6_camera =
    `Shot on iPhone front camera, 9:16 vertical, natural daylight from ${setting_paragraph.split('.')[0]?.toLowerCase() ?? 'the scene setting'}, slightly shaky handheld feel. ` +
    `FRAMING: shoulders + head + upper chest in frame, face centered, arms-length selfie distance — REPRODUCIBLE across every downstream clip. ` +
    `LIGHTING: even soft daylight, no harsh shadows, no beauty ring light, no flash, no post-hoc color grading.`;

  // Block 7 — Anti-AI directive (verbatim Kling 3.0 guide anchor).
  const block7_antiAiDirective =
    'ABSOLUTELY NO phones, cameras, screens, social media UI, floating text, or digital overlays visible anywhere in the frame.';

  return [
    block1_selfieLead,
    block2_physicalFeatures,
    block3_setting,
    block4_skinRealism,
    block5_antiCelebrity,
    block6_camera,
    block7_antiAiDirective,
  ].join('\n\n');
}
