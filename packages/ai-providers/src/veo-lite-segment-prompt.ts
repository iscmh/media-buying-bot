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
 * the same prefix so Veo's per-clip generation can't drift the
 * character. Anchors 5 invariants: identity/age/gender/role,
 * physical features, setting, camera/framing, wardrobe.
 *
 * Keep this format stable across clips — Veo's attention picks up
 * on repeated leading tokens as "the character is the same one."
 */
export function composeCharacterLockPrefix(lock: CharacterLock): string {
  const pronoun = lock.gender === 'male' ? 'He' : 'She';
  return [
    `CHARACTER LOCK — this ${lock.age}-year-old ${lock.nationality} ${lock.gender} named ${lock.name} ` +
      `(${lock.demographic_role}) is the SAME PERSON across every clip in this batch. Do not drift.`,
    'PHYSICAL INVARIANTS (verbatim, do not restyle):',
    `  - ${lock.hair_bullet}`,
    `  - ${lock.eye_asymmetry_bullet}`,
    `  - ${lock.nose_bullet}`,
    `  - ${lock.mouth_bullet}`,
    `  - ${lock.eye_color_and_age_detail}`,
    `  - ${lock.jaw_bullet}`,
    `  - ${lock.face_shape_bullet}`,
    `  - ${lock.skin_age_appropriate_detail}`,
    `WARDROBE INVARIANT: ${lock.clothing_bullet} — same outfit across all clips.`,
    `SETTING: ${lock.setting_paragraph}`,
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
