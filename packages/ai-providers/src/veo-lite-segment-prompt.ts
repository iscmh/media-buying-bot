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
import type { CharacterLock } from '@mbb/shared';

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
 * Compose the CHARACTER LOCK PREFIX. Every clip in a batch gets
 * the SAME prefix so Veo's per-clip generation can't drift.
 *
 * Polish-23 Commit 3.0.25 rewrite — operator's "each clip is
 * different, this is useless" ship-blocker. kie.ai's Veo endpoint
 * exposes no image-reference-strength / weight parameter (verified
 * against buildKieVeoRequestBody wire body + docs), so prompt
 * aggression is the ONLY lever. The rewrite matches BCH's approach:
 * lead with an unambiguous MATCH REFERENCE IMAGE EXACTLY
 * imperative, repeat physical invariants verbatim, follow with
 * explicit REJECT/NEVER negative constraints Veo weights heavily,
 * and lock wardrobe + setting to the reference image separately.
 *
 * Layout (STABLE across clips — Veo's attention rewards repetition):
 *   1. MATCH REFERENCE IMAGE EXACTLY imperative + failure framing
 *   2. IDENTITY line (age/nationality/gender/name/role)
 *   3. PHYSICAL INVARIANTS bullet list (verbatim from lock)
 *   4. BODY INVARIANT block (weight / proportions anchor)
 *   5. SETTING INVARIANT + full setting paragraph
 *   6. Explicit REJECT block (body/weight/age/features/setting)
 *   7. WARDROBE lock (clothing_bullet + SAME/NEVER language)
 *   8. SETTING lock (SAME/NEVER language)
 *   9. Speaking-to-camera framing line (pronoun-specific)
 */
export function composeCharacterLockPrefix(lock: CharacterLock): string {
  const pronoun = lock.gender === 'male' ? 'He' : 'She';
  return [
    // Block 1 — aggressive MATCH REFERENCE opening.
    'CHARACTER LOCK — MATCH REFERENCE IMAGE EXACTLY.',
    'This character is the SAME PERSON as shown in the reference image AND the SAME PERSON across every clip in this batch. Any deviation from the reference image is a FAILURE.',
    '',
    // Block 2 — identity.
    `IDENTITY: ${lock.age}-year-old ${lock.nationality} ${lock.gender} named ${lock.name} (${lock.demographic_role}).`,
    '',
    // Block 3 — physical invariants, verbatim.
    'PHYSICAL INVARIANTS (verbatim per clip — do not restyle, do not soften):',
    `  - ${lock.hair_bullet}`,
    `  - ${lock.eye_asymmetry_bullet}`,
    `  - ${lock.nose_bullet}`,
    `  - ${lock.mouth_bullet}`,
    `  - ${lock.eye_color_and_age_detail}`,
    `  - ${lock.jaw_bullet}`,
    `  - ${lock.face_shape_bullet}`,
    `  - ${lock.skin_age_appropriate_detail}`,
    '',
    // Block 4 — body invariant (weight / proportions anchor).
    'BODY INVARIANT (do NOT drift build / weight / proportions across clips):',
    `  - ${lock.body_invariant_bullet}`,
    '',
    // Block 5 — setting invariant + full setting paragraph.
    'SETTING INVARIANT (do NOT change position / furniture / background objects across clips):',
    `  - ${lock.setting_invariant_bullet}`,
    `SETTING: ${lock.setting_paragraph}`,
    '',
    // Block 6 — explicit REJECT block per operator's spec.
    // Polish-23 Commit 3.0.26: extended to 7 constraints (added
    // wardrobe + lighting). Each REJECT sits on its own line so
    // Veo's attention weights them independently rather than
    // averaging into a single long sentence.
    'REJECT any change in body type.',
    'REJECT any change in weight.',
    'REJECT any change in age.',
    'REJECT any change in facial features.',
    'REJECT any change in wardrobe.',
    'REJECT any change in setting.',
    'REJECT any change in lighting.',
    'REJECT any output that shows a different body type, different weight, or different body proportions than the reference image and the invariants above.',
    '',
    // Block 7 — WARDROBE lock. Keep the "WARDROBE INVARIANT" label
    // (pinned by tests) but include the operator-specified SAME/NEVER
    // language + Reference: excerpt on their own lines so Veo weights
    // each independently.
    `WARDROBE INVARIANT (LOCK): ${lock.clothing_bullet}`,
    'SAME clothing as reference image. NEVER change wardrobe.',
    `Reference: ${lock.clothing_bullet}`,
    '',
    // Block 8 — SETTING lock (SAME/NEVER language + Reference: excerpt).
    'SETTING LOCK: SAME setting / room / background as reference image. NEVER change environment.',
    `Reference: ${lock.setting_paragraph}`,
    '',
    // Block 9 — framing / camera line.
    `${pronoun} is speaking directly to the camera in a vertical iPhone selfie, 9:16, handheld.`,
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
  const prefix = composeCharacterLockPrefix(lock);
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
  parts.push(
    '',
    'CAMERA: iPhone front camera, 9:16 vertical, slightly shaky handheld feel, natural indoor light.',
    'ABSOLUTELY NO on-screen text, captions, floating text, social media UI, watermarks, or digital overlays. ' +
      'ABSOLUTELY NO phones, cameras, screens, tablets, or laptops visible anywhere in the frame.',
  );
  return { prompt: parts.join('\n'), wordCountCheck };
}
