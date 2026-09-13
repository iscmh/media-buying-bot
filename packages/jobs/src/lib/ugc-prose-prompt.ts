/**
 * Polish-29.0.40 Commit 149: shared UGC-prose prompt builder ported
 * from the `seedance25-ugc-yapper` skill playbook.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every talking-head UGC pipeline we ship (polish29 Seedance via
 * Dreamina, polish30 Omni 1.1 Flash via Google Flow, and the future
 * kie.ai Seedance 2.5 worker) benefits from the same set of prompting
 * principles:
 *
 *   1. Flowing natural-language PROSE, not bracketed / labelled fields.
 *      Bracketed templates fight the generator's own scene parser;
 *      prose in `subject → action/event → scene/environment → visual
 *      style → camera → sound` order is what every diffusion-based
 *      video model was trained on.
 *
 *   2. Single camera behaviour per clip. "Selfie handheld with slow
 *      wrist drift" OR "static tripod locked-off frame", never both.
 *      Combined camera moves destabilise the image and read as
 *      cinematic — the exact tell you're trying to hide.
 *
 *   3. Positive statements only. Never `edit`, `add`, `remove`,
 *      `delete`, `modify`, `replace`, `change`, `extend`, `continue`,
 *      `strictly edit`. These words silently reclassify the task type
 *      inside Seedance's router; even when the target model has no
 *      such router, they signal "this is a delta over another asset"
 *      which the generator then invents to satisfy.
 *
 *   4. Uneven practical light + deep focus + skin / framing
 *      imperfection. These are the anti-AI-tell tokens — cinematic
 *      bokeh, symmetric key lighting, and glass-perfect skin are what
 *      viewers pattern-match on within 500ms.
 *
 *   5. Constraint tail verbatim on every prompt. Vertical generation
 *      has a much higher chance of the model inventing subtitles /
 *      watermarks / a second visible phone than landscape does. The
 *      exclusion is load-bearing, not decoration. The phone
 *      exclusion matters because the phone IS the camera — the
 *      generator's instinct is to put another one in the subject's
 *      hand.
 *
 *   6. Natural UGC delivery runs ~3 words per second (~180 wpm), NOT
 *      the 135 wpm we were shipping at Polish-29.0.34. TikTok
 *      talking-head creators run faster than broadcast news readers.
 *      Under-target and Seedance pads with dead air or invents
 *      filler; over-target and the mouth outruns the audio.
 *
 * PROVIDER NOTATION
 * -----------------
 * The playbook uses `{curly braces}` for dialogue and `@Image N` for
 * asset binding — both are Seedance 2.5 conventions and are not
 * necessarily honoured by Google Flow's Omni router. This builder
 * therefore returns the CORE prose, and lets callers wrap it with
 * whatever notation their provider needs (Seedance 2.5 curly braces,
 * or a quoted line for Omni).
 *
 * REFERENCE ASSETS
 * ----------------
 * Every caller of this builder already ships a persona still (Nano
 * Banana Pro / 2 Lite) as the visual anchor to the video model. We
 * don't repeat the persona's face/clothing/room in the prose because
 * the image reference is a stronger signal than any text
 * description — restating it invites the model to reinterpret rather
 * than obey the reference.
 */

/**
 * Verbatim constraint tail from the playbook. Adjust ONLY the pronoun
 * per persona.gender at call time.
 *
 * Cascade:
 *   - "No music" → the model's TTS layer stops emitting a bed track
 *     it invented from the prose word "ad" / "review" / "hook".
 *   - "No subtitles" → vertical 9:16 doubles the model's baseline
 *     rate of inventing burnt-in captions. This is the single most
 *     important line in the tail.
 *   - "No watermark. No logo." → strips the invented "TikTok /
 *     Instagram Reels" corner glyph the model has memorised.
 *   - Phone + camera + tripod + mirror exclusion → the model's
 *     instinct on a selfie prompt is to make the phone visible in the
 *     subject's hand, so it has to be explicitly banned.
 *   - "Face stays stable without deformation" → the small-face
 *     drift-per-frame problem in short-clip talking-head models.
 */
export function ugcConstraintTail(gender: string): string {
  const gLower = (gender ?? '').toLowerCase();
  const pronoun = gLower === 'male' || gLower === 'man' || gLower === 'guy' ? 'his' : 'her';
  return [
    `No music. No subtitles. No watermark. No logo.`,
    `No phone, camera, tripod or mirror visible anywhere in frame or in ${pronoun} hands.`,
    `${pronoun.charAt(0).toUpperCase() + pronoun.slice(1)} face stays stable without deformation,`,
    `movements natural and smooth with no stutter or flicker.`,
  ].join(' ');
}

/**
 * Per-persona subject clause. Kept short — the image reference does
 * the heavy lifting for identity. The prose only supplies the
 * demographic + one-line look so the sound world lines up.
 */
export function ugcSubjectClause(persona: {
  age_range: string;
  ethnicity: string;
  gender: string;
  look: string;
}): string {
  return `A ${persona.age_range} ${persona.ethnicity} ${persona.gender.toLowerCase()}, ${persona.look}`;
}

/**
 * Per-model camera + delivery block. Every talking-head UGC clip we
 * ship uses selfie handheld — walk-and-talk degrades in every model
 * we've tested and static tripod reads too "reviewer" for the ad
 * hook use case. If a future clip needs static tripod, pass
 * `cameraMode: 'static'`.
 */
export function ugcCameraAndDeliveryBlock(input: {
  cameraMode?: 'selfie' | 'static';
  clipSeconds: number;
  targetWordsPerSecond?: number;
}): string {
  const camera = input.cameraMode ?? 'selfie';
  const wps = input.targetWordsPerSecond ?? 3;
  const wpm = Math.round(wps * 60);
  if (camera === 'static') {
    return [
      `Filmed on a phone propped on a shelf, locked-off vertical 9:16 frame, eye level, medium close-up on face and upper chest.`,
      `Subject drifts naturally inside the frame. Deep focus — the room behind stays sharp. No cinematic bokeh, no rack focus, no dolly, no zoom, no pan.`,
      `Uneven practical light: warm window light on one side of the face, cooler ceiling light on the other, with a small blown-out highlight somewhere.`,
      `Real skin texture with visible pores and a few flyaway hairs, unretouched colour, one continuous take with no cuts.`,
      `Delivery is warm, sincere, casual, direct to camera at roughly ${wpm} words per minute (~${wps} words per second) — the natural upper-conversational pace of a TikTok creator, not broadcast news. Fill the entire runtime with speech; no silent gaps.`,
    ].join(' ');
  }
  return [
    `Filmed on a front-facing phone camera held at arm's length, eye level, medium close-up on face and upper chest, vertical 9:16, one continuous take with no cuts.`,
    `Slow wrist drift and micro-corrections in framing — no zoom, no pan, no dolly, no tilt, no push-in, no pull-out.`,
    `Uneven practical light: warm window light on one side of the face, cooler indoor light on the other, with a small blown-out highlight somewhere.`,
    `Deep focus — the room behind stays sharp. Real skin texture with visible pores and a few flyaway hairs, unretouched colour, slightly crooked framing that drifts as the wrist tires.`,
    `Delivery is warm, sincere, casual, direct to camera at roughly ${wpm} words per minute (~${wps} words per second) — the natural upper-conversational pace of a TikTok creator, not broadcast news.`,
    `${input.clipSeconds}-second clip. Keep speaking naturally throughout the entire ${input.clipSeconds} seconds — the dialogue below is sized to fill the runtime, do NOT leave silent gaps between sentences or pauses in the middle. If you finish the sentence a beat early, extend the final syllables warmly rather than falling silent.`,
  ].join(' ');
}

/**
 * Persona voice descriptor line. Playbook: "In the voice of @Audio 1
 * — fast, dry, mildly irritated — she says {…}". This shared version
 * omits the `@Audio 1` binding (Seedance-specific) and yields a plain
 * "in a <voice> tone" clause both providers understand.
 *
 * Polish-29.0.58 Commit 167: BEEFED UP the voice clause into a
 * detailed voice fingerprint. First live Seedance runs showed voice
 * drifting between clips within a single variation — even with the
 * same character image, Seedance's TTS layer picked a different
 * voice per clip because each clip is an independent i2v render
 * (no cross-clip voice reference like Omni's V2V-extend chain).
 *
 * The only lever we have is the prompt. Vague voice hints
 * ("plain, unhurried") give TTS too much room to pick differently
 * each call. Concrete fingerprints — age, pitch, texture, accent,
 * pace — narrow the sample space and increase the chance the model
 * picks the same voice on every clip within a variation.
 *
 * The fingerprint is DETERMINISTIC from the persona fields (gender +
 * age_range + ethnicity) so all clips in a variation get IDENTICAL
 * voice prose. When a `voice_direction` is set explicitly (future
 * Claude batch schema addition), it appends as an extra layer on top
 * of the generated fingerprint rather than replacing it.
 */
export function ugcVoiceClause(persona: {
  gender: string;
  age_range?: string;
  ethnicity?: string;
  voice_direction?: string;
}): string {
  const gLower = (persona.gender ?? '').toLowerCase();
  const isMale = gLower === 'male' || gLower === 'man' || gLower === 'guy';
  const subject = isMale ? 'He' : 'She';

  // Pitch band from gender + age. Values within each group are
  // deliberately close so a Claude persona batch that returns "25"
  // and one that returns "20s" both land in the same band.
  const ageStr = (persona.age_range ?? '').toLowerCase();
  const ageNum = extractAge(ageStr);
  let pitch: string;
  if (isMale) {
    if (ageNum <= 25) pitch = 'medium-high, slightly nasal, youthful';
    else if (ageNum <= 40) pitch = 'medium, warm, grounded';
    else pitch = 'medium-low, slightly gravelly, seasoned';
  } else {
    if (ageNum <= 25) pitch = 'medium-high, clear, slightly upspoken';
    else if (ageNum <= 40) pitch = 'medium, warm, alto range';
    else pitch = 'medium-low, mature, unhurried';
  }

  // Accent bucket from ethnicity. Kept generic-American across the
  // board because niche accents (British, Australian, non-native
  // English) DIVERGE Seedance's voice picker across clips even more
  // than the vague-tone fallback did. A shared American baseline is
  // the closest we can get to "same voice every call".
  const accent = 'general American accent, no vocal fry, no exaggerated upspeak';

  // Delivery hint stays tight — same style across all clips.
  const deliveryTone =
    persona.voice_direction?.trim() ?? 'warm, sincere, conversational, direct-to-camera';

  return (
    `${subject} speaks in a ${pitch} voice — ${accent} — with a ${deliveryTone} delivery, ` +
    `the same voice across every second of the clip`
  );
}

/**
 * Extract a numeric age midpoint from a Claude-emitted age_range
 * string. Handles "20s", "30s", "40-50", "60s", plain integers, and
 * empty/malformed strings (defaults to 30 so pitch lands in the
 * medium band). Not exported — helper for the voice fingerprint.
 */
function extractAge(raw: string): number {
  if (!raw) return 30;
  const decadeMatch = /(\d{2})s\b/.exec(raw);
  if (decadeMatch) return Number(decadeMatch[1]) + 5;
  const rangeMatch = /(\d{2})\s*[-–]\s*(\d{2})/.exec(raw);
  if (rangeMatch) {
    const lo = Number(rangeMatch[1]);
    const hi = Number(rangeMatch[2]);
    return Math.round((lo + hi) / 2);
  }
  const plainMatch = /(\d{2})/.exec(raw);
  if (plainMatch) return Number(plainMatch[1]);
  return 30;
}

/**
 * The end sound-world sentence. Rooms have hum. The playbook: "Close
 * front-camera mic with slight compression, faint bathroom fan hum
 * and tile room tone." Without this the model's TTS defaults to
 * anechoic studio silence which reads as ad, not UGC.
 */
export const UGC_SOUND_WORLD = `Close front-camera mic with slight compression, faint room tone and background hum only. No music bed.`;

/**
 * The full clip prose, minus the dialogue notation (each caller wraps
 * the dialogue in the provider-appropriate syntax: `{}` for Seedance
 * 2.5, `"..."` for Omni). The dialogue placeholder is `__DIALOGUE__`
 * and the caller substitutes.
 */
export function buildUgcClipProse(input: {
  persona: {
    age_range: string;
    ethnicity: string;
    gender: string;
    look: string;
    voice_direction?: string;
  };
  cameraMode?: 'selfie' | 'static';
  clipSeconds: number;
  targetWordsPerSecond?: number;
  /** Optional extra scene-continuity sentence. E.g. seed-clip pin-frame rule. */
  extraSceneRule?: string;
}): string {
  const parts: string[] = [];
  parts.push(ugcSubjectClause(input.persona) + '.');
  parts.push(
    ugcCameraAndDeliveryBlock({
      cameraMode: input.cameraMode,
      clipSeconds: input.clipSeconds,
      targetWordsPerSecond: input.targetWordsPerSecond,
    }),
  );
  if (input.extraSceneRule) parts.push(input.extraSceneRule);
  parts.push(
    `${ugcVoiceClause({
      gender: input.persona.gender,
      age_range: input.persona.age_range,
      ethnicity: input.persona.ethnicity,
      voice_direction: input.persona.voice_direction,
    })}: __DIALOGUE__`,
  );
  parts.push(UGC_SOUND_WORLD);
  parts.push(ugcConstraintTail(input.persona.gender));
  return parts.join(' ');
}
