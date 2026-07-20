/**
 * Polish-23 Commit 2: per-segment prompt composer for kie.ai Veo
 * 3.1 Lite clips in the Higgsfield-Soul UGC pipeline.
 *
 * Each 60s ad is 8 clips × 8s. Every clip's Veo prompt gets the
 * CHARACTER LOCK PREFIX so the model can't drift the face / voice
 * / setting across the chain, even though only clip 1 uses the
 * Higgsfield Soul reference PNG as first-frame anchor.
 *
 * Word-count calibration (Polish-19.4.2 pattern, retuned for
 * Veo Lite):
 *   - 8s of dialogue @ 170wpm natural yapping pace = 22-24 words
 *   - Word count = spoken words inside quotes ONLY (excludes
 *     speaker attribution + visual/sound description)
 *   - Under-fill → Veo pads with dead air / lip-flap. Over-fill
 *     → speech gets rushed / clips the tail.
 *
 * The composer is pure (no I/O, no imports beyond @mbb/shared) so
 * it runs client-side in the estimator and server-side in the
 * worker without bundler complaints.
 */
import type { CharacterLock, Polish23SettingDetails } from '@mbb/shared';

export interface VeoLiteSegmentSpec {
  /** 0-indexed clip position in the batch (0…totalSegments-1). */
  segmentIndex: number;
  /** Total clips in the batch (e.g. 8 for a 60s ad). */
  totalSegments: number;
  /**
   * Spoken dialogue for THIS clip. Must be 20-24 words. Callers
   * (Claude ad-spec generator) target the range; the composer
   * validates and surfaces the drift so a mis-sized clip is caught
   * before Veo credits are spent.
   */
  dialogue: string;
  /**
   * One-sentence visual scene direction for THIS clip. What the
   * character is doing / holding / where they're moving. NOT
   * character-appearance description — that's carried by the
   * CHARACTER LOCK prefix and the reference image.
   */
  sceneDirection: string;
  /**
   * Optional per-clip emotional beat ("frustrated", "reassured",
   * "curious"). Threaded into the prompt so Veo modulates
   * expression / pace / voice tone across the chain.
   */
  emotionalBeat?: string;
  /**
   * Polish-23 Commit 3.0.30: optional structured setting details
   * from the source-video vision analysis. When provided, the
   * SETTING INVARIANT block uses persona.setting_details fields
   * (room_or_place, key_props, lighting) verbatim. Absent → the
   * block falls back to lock.setting_paragraph excerpts + a
   * placeholder props list.
   */
  settingDetails?: Polish23SettingDetails;
}

/** Speech-rate calibration constants. Exported for tests + docs. */
export const VEO_LITE_WPM = 170;
export const VEO_LITE_CLIP_SECONDS = 8;
export const VEO_LITE_MIN_DIALOGUE_WORDS = 20;
export const VEO_LITE_MAX_DIALOGUE_WORDS = 24;

/**
 * Count spoken words in a dialogue string. Splits on whitespace and
 * drops empty tokens. Does NOT strip punctuation from words — Veo's
 * prompt tokenizer treats "don't" as one word, so should we.
 */
export function countDialogueWords(dialogue: string): number {
  return dialogue.trim().split(/\s+/).filter(Boolean).length;
}

export interface DialogueWordCountCheck {
  ok: boolean;
  wordCount: number;
  min: number;
  max: number;
  message?: string;
}

/**
 * Runtime check callers use before spending Veo credits on a
 * mis-sized clip. Not a throw — the worker downgrades to a
 * warning-log if it wants to run through anyway.
 */
export function checkDialogueWordCount(dialogue: string): DialogueWordCountCheck {
  const wordCount = countDialogueWords(dialogue);
  if (wordCount < VEO_LITE_MIN_DIALOGUE_WORDS) {
    return {
      ok: false,
      wordCount,
      min: VEO_LITE_MIN_DIALOGUE_WORDS,
      max: VEO_LITE_MAX_DIALOGUE_WORDS,
      message:
        `Dialogue is ${wordCount} words; Veo 3.1 Lite 8s clips need ${VEO_LITE_MIN_DIALOGUE_WORDS}-${VEO_LITE_MAX_DIALOGUE_WORDS} ` +
        `(~${VEO_LITE_WPM}wpm × ${VEO_LITE_CLIP_SECONDS}s). Under-fill pads with dead air / lip-flap.`,
    };
  }
  if (wordCount > VEO_LITE_MAX_DIALOGUE_WORDS) {
    return {
      ok: false,
      wordCount,
      min: VEO_LITE_MIN_DIALOGUE_WORDS,
      max: VEO_LITE_MAX_DIALOGUE_WORDS,
      message:
        `Dialogue is ${wordCount} words; Veo 3.1 Lite 8s clips need ${VEO_LITE_MIN_DIALOGUE_WORDS}-${VEO_LITE_MAX_DIALOGUE_WORDS} ` +
        `(~${VEO_LITE_WPM}wpm × ${VEO_LITE_CLIP_SECONDS}s). Over-fill rushes speech / clips the tail.`,
    };
  }
  return {
    ok: true,
    wordCount,
    min: VEO_LITE_MIN_DIALOGUE_WORDS,
    max: VEO_LITE_MAX_DIALOGUE_WORDS,
  };
}

/**
 * Polish-23 Commit 3.0.27: seed range for kie.ai's Veo endpoint.
 * Documented 10000-99999 (5-digit integer). Same seed passed on
 * every clip of a batch = the point of this field per kie.ai's
 * docs: "Same seed generates similar video content."
 *
 * https://docs.kie.ai/veo3-api/generate-veo-3-video
 */
export const POLISH23_VEO_SEED_MIN = 10000;
export const POLISH23_VEO_SEED_MAX = 99999;

/**
 * Polish-23 Commit 3.0.27: single Veo Negative prompt used on
 * EVERY clip in a batch. Google's Veo prompting guide states that
 * negative prompting is "declarative, not instructive — the model
 * responds poorly to commands like 'don't' or 'no'. Instead, list
 * unwanted concepts as keywords." This constant is a bare
 * comma-separated keyword list, no imperative verbs.
 *
 * The list absorbs both the character-consistency guards (different
 * person, weight change, age change, wardrobe change, lighting
 * change, setting change, plastic skin, morph, extra limbs) AND the
 * Polish-21.0.7 anti-AI-artifact guards (phones/cameras/screens in
 * frame, on-screen text / captions / watermarks / social media UI /
 * digital overlays), which prior commits carried in a separate
 * "ABSOLUTELY NO …" line. Consolidating them into one Negative:
 * keyword list matches Google's own recommended shape.
 */
export const POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS =
  'different person, weight change, age change, wardrobe change, lighting change, ' +
  'setting change, cartoon, animated, plastic skin, morph, extra limbs, watermark, ' +
  'subtitles, text overlay, on-screen text, captions, social media UI, digital overlays, ' +
  'phones in frame, cameras in frame, screens in frame, tablets, laptops';

/**
 * Polish-23 Commit 3.0.27: literal 1-2 sentence caption of what
 * the Higgsfield Soul reference image (threaded via kie.ai's
 * imageUrls[]) actually shows. Prepended to every clip prompt so
 * Veo's text-and-image conditioning fuse against the same anchor.
 *
 * Also persisted to metadata.polish23_reference_image_caption for
 * SQL forensics — the operator can verify what got threaded without
 * grepping Vercel logs.
 */
/**
 * Polish-23 Commit 3.0.30: SETTING INVARIANT block composer.
 * Character consistency landed in 3.0.28-3.0.29 (persona-mirror
 * mode + WaveSpeedAI stability), but real-run evidence showed
 * background/setting still drifted across clips — living room
 * shifts between shots, framing changes, prop positions move.
 *
 * The SETTING field inside the CHARACTER SHEET wasn't enforced
 * with the same aggression as the character identity. This helper
 * emits a dedicated block right after the sheet with:
 *   - ROOM: room_or_place (from persona setting_details, or a
 *           first-sentence excerpt of lock.setting_paragraph when
 *           the persona isn't available)
 *   - PROPS: verbatim key_props list from persona (or a
 *            "(inferred from reference image)" placeholder)
 *   - LIGHTING: persona lighting (or the default even-daylight)
 *   - FRAMING: fixed medium-close-up eye-level composition
 *     (REPRODUCIBLE across clips — the operator's spec pin)
 *   - BACKGROUND ELEMENTS: props positioned identically as
 *     the reference image
 *
 * NOTE ON REJECT LANGUAGE: Commit 3.0.27 replaced command-form
 * REJECTs with a bare Negative: keyword list based on Google's
 * Veo 3.1 guide ("declarative, not instructive"). Real-run
 * evidence in Commit 3.0.30 shows that IDENTITY-only Negative
 * keywords weren't enough to hold the setting stable. This block
 * intentionally walks back to command-form REJECTs for the
 * setting-specific case + emits SAME/IDENTICAL language per the
 * operator's spec. If drift persists we'll revisit; for now the
 * operator's field evidence trumps Google's general guidance.
 */
export function composeSettingInvariantBlock(
  settingDetails: Polish23SettingDetails | undefined,
  lock: CharacterLock,
): string {
  const room =
    settingDetails?.room_or_place ??
    lock.setting_paragraph.split('.')[0]?.trim() ??
    lock.setting_paragraph;
  const propsList = settingDetails?.key_props?.length
    ? settingDetails.key_props.join(', ')
    : '(inferred from reference image)';
  const lighting =
    settingDetails?.lighting ?? 'even soft natural window light, no harsh shadows, no flash';
  return [
    'SETTING INVARIANT (identical across all clips):',
    `ROOM: ${room}`,
    `PROPS: ${propsList}`,
    `LIGHTING: ${lighting}`,
    'FRAMING: medium close-up, character seated, camera at eye level, same angle throughout.',
    'CAMERA: iPhone front camera, 9:16 vertical, arms-length selfie distance, slightly shaky handheld feel.',
    'The setting is IDENTICAL across all clips — same room, same angle, same lighting, same props in same positions.',
    'REJECT any change in background/setting.',
    'REJECT any change in camera angle or framing.',
    'REJECT any change in prop positions.',
    'REJECT any change in lighting direction or quality.',
  ].join('\n');
}

export function composeReferenceImageCaption(lock: CharacterLock): string {
  // Trim to first sentence for the setting excerpt so the caption
  // stays punchy (Veo weights the first ~150 words heaviest per
  // Google's guide).
  const settingLead = lock.setting_paragraph.split('.')[0]?.trim() ?? lock.setting_paragraph;
  return (
    `The reference image (shown in imageUrls) depicts a ${lock.age}-year-old ` +
    `${lock.nationality} ${lock.gender} named ${lock.name} (${lock.demographic_role}), ` +
    `wearing ${lock.clothing_bullet.replace(/^-\s*/, '').replace(/^Clothing:\s*/i, '')}, ` +
    `in ${settingLead.charAt(0).toLowerCase()}${settingLead.slice(1)}.`
  );
}

/**
 * Compose the CHARACTER LOCK PREFIX. Every clip in a batch gets
 * the SAME prefix — Veo's positional-attention mechanism rewards
 * verbatim repetition of the character block across clips per
 * community consensus (skywork.ai, sider.ai, tenten.co JSON prompt
 * guides 2025-2026) + Google Cloud's Veo 3.1 prompting guide.
 *
 * Polish-23 Commit 3.0.27 rewrite — replaces the 3.0.25/3.0.26
 * "MATCH REFERENCE IMAGE EXACTLY" + 7-REJECT prose prefix based on
 * research findings:
 *
 *   - Google's Veo 3.1 prompting guide explicitly says negative
 *     prompting should be "declarative, not instructive" —
 *     command-form "REJECT any change in X" underperforms bare
 *     keyword lists. The old 7-REJECT block was net-negative.
 *   - Structured character sheets with fielded labels (subject /
 *     face / hair / body / wardrobe / setting / lighting / camera)
 *     beat prose across every convergent 2025-2026 guide.
 *   - Reference image literal-caption prepend is a Google-guide
 *     pattern that fuses text + image conditioning against the
 *     same anchor.
 *   - First-person identity anchoring — operator's explicit spec
 *     addition — reinforces the "same person" lock without the
 *     shouting imperative.
 *
 * Layout (STABLE across clips):
 *   1. Identity line (age / nationality / gender / name / role +
 *      SAME PERSON across every clip anchor)
 *   2. REFERENCE IMAGE: literal 1-sentence caption
 *   3. CHARACTER SHEET (fielded, identical across all 8 clips)
 *   4. IDENTITY ANCHOR (first-person "I am … the SAME PERSON …")
 *   5. ACTION (third-person speaking-to-camera line)
 *   6. Negative: bare comma-separated keyword list
 */
export function composeCharacterLockPrefix(
  lock: CharacterLock,
  settingDetails?: Polish23SettingDetails,
): string {
  const pronoun = lock.gender === 'male' ? 'He' : 'She';
  // Strip leading "- " from clothing_bullet for clean sheet + anchor
  // embedding; retain the raw bullet text for the SHEET field.
  const wardrobeText = lock.clothing_bullet.replace(/^-\s*/, '').replace(/^Clothing:\s*/i, '');
  const settingLead =
    settingDetails?.room_or_place ??
    lock.setting_paragraph.split('.')[0]?.trim() ??
    lock.setting_paragraph;

  // Void unused locals — kept in scope in case a future revision
  // wants to embed them; current tight layout below inlines the
  // clothing/setting excerpts differently.
  void wardrobeText;
  return [
    // Block 1 — identity line (keeps SAME PERSON language pinned by
    // tests since Commit 2).
    `CHARACTER LOCK — this ${lock.age}-year-old ${lock.nationality} ${lock.gender} named ${lock.name} ` +
      `(${lock.demographic_role}) is the SAME PERSON across every clip in this batch.`,
    '',
    // Block 2 — literal reference-image caption (fuses text + image
    // conditioning against one description).
    `REFERENCE IMAGE: ${composeReferenceImageCaption(lock)}`,
    '',
    // Block 3 — structured CHARACTER SHEET. Field labels match the
    // community-consensus 2025-2026 shape. Kept tight per Google's
    // Veo 3.1 guide "weights the first ~150 words heaviest": FACE
    // stays a 2-bullet summary rather than a 6-bullet dump; SETTING
    // omits the setting_invariant_bullet (that content lives in the
    // Higgsfield Soul reference image already).
    'CHARACTER SHEET (identical across all 8 clips):',
    `NAME: ${lock.name}`,
    `GENDER: ${lock.gender}`,
    `AGE: ${lock.age}`,
    `ETHNICITY: ${lock.nationality}`,
    `DEMOGRAPHIC: ${lock.demographic_role}`,
    `FACE: ${lock.face_shape_bullet}. ${lock.eye_color_and_age_detail}.`,
    `BODY: ${lock.body_invariant_bullet}`,
    `HAIR: ${lock.hair_bullet}`,
    `SKIN: ${lock.skin_age_appropriate_detail}`,
    `WARDROBE: ${lock.clothing_bullet}`,
    `SETTING: ${lock.setting_paragraph}`,
    '',
    // Block 3.5 — SETTING INVARIANT (Polish-23 Commit 3.0.30 —
    // real-run background/setting drift fix). Sits between the
    // CHARACTER SHEET and the IDENTITY ANCHOR so Veo's positional
    // attention treats it as parallel-priority to the character
    // identity. Deliberately walks back the 3.0.27 declarative-only
    // stance and uses command-form REJECTs for the setting-specific
    // case — operator's field evidence trumps Google's general
    // guidance on this axis.
    composeSettingInvariantBlock(settingDetails, lock),
    '',
    // Block 4 — IDENTITY ANCHOR (first-person). Reinforces "same
    // person" + "same setting" without the shouting imperative.
    // Polish-23 Commit 3.0.30 adds the setting clause per operator
    // spec: "I am in the SAME <room> as the reference image. The
    // camera is at the SAME angle. The lighting and props are
    // IDENTICAL."
    `IDENTITY ANCHOR: I am ${lock.name}, the SAME PERSON shown in the reference image. ` +
      `I am in the SAME ${settingLead} as the reference image. The camera is at the SAME ` +
      `angle. The lighting and props are IDENTICAL.`,
    '',
    // Block 5 — ACTION line (third-person camera direction).
    `ACTION: ${pronoun} is speaking directly to the camera in a vertical iPhone selfie, 9:16, handheld.`,
    '',
    // Block 6 — Negative keyword list (bare, no command verbs — per
    // Google's own guide "declarative, not instructive"). Setting-
    // specific REJECTs live in the SETTING INVARIANT block above.
    `Negative: ${POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS}`,
  ].join('\n');
}

/**
 * Compose the full per-clip Veo prompt: CHARACTER LOCK PREFIX +
 * segment header (position + word-budget reminder) + dialogue +
 * scene direction + Veo-specific tail (no on-screen text, no
 * phones-in-frame — same anti-AI directive Polish-21.0.7 used for
 * Nano Banana seeds).
 *
 * Returns the composed prompt AND a word-count check so the caller
 * can gate on it. Does NOT throw on drift — the worker decides.
 */
export interface ComposedVeoLiteSegmentPrompt {
  prompt: string;
  wordCountCheck: DialogueWordCountCheck;
}

export function composeVeoLiteSegmentPrompt(
  lock: CharacterLock,
  spec: VeoLiteSegmentSpec,
): ComposedVeoLiteSegmentPrompt {
  // Polish-23 Commit 3.0.27: the CAMERA + anti-AI directive lines
  // that used to sit here are now absorbed into the structured
  // CHARACTER SHEET (CAMERA field) + the Negative keyword list
  // inside composeCharacterLockPrefix. Nothing further to append —
  // per-clip content is just segment header + dialogue + scene +
  // optional emotional beat.
  const prefix = composeCharacterLockPrefix(lock, spec.settingDetails);
  const wordCountCheck = checkDialogueWordCount(spec.dialogue);
  const emotionalLine = spec.emotionalBeat ? `Emotional beat: ${spec.emotionalBeat}.` : undefined;
  const parts: string[] = [
    prefix,
    '',
    `SEGMENT ${spec.segmentIndex + 1}/${spec.totalSegments} — ${VEO_LITE_CLIP_SECONDS}s (target ${VEO_LITE_MIN_DIALOGUE_WORDS}-${VEO_LITE_MAX_DIALOGUE_WORDS} spoken words):`,
    `DIALOGUE: "${spec.dialogue.trim()}"`,
    `SCENE: ${spec.sceneDirection.trim()}`,
  ];
  if (emotionalLine) parts.push(emotionalLine);
  return { prompt: parts.join('\n'), wordCountCheck };
}
