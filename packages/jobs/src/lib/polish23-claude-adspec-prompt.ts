/**
 * Polish-23 Commit 3: Claude ad-spec generator prompt + parser.
 *
 * From a source concept transcription, Claude emits ONE JSON object:
 *   {
 *     character_lock: CharacterLock,            // 15 fields, verbatim schema
 *     segments: SegmentSpec[]                   // exactly N=8 items
 *   }
 *
 * `character_lock` seeds the Higgsfield Soul reference PNG + threads
 * into every Veo Lite clip's CHARACTER LOCK prefix. It must be
 * composed ONCE (this step) and shared verbatim downstream —
 * re-composing per segment defeats the point.
 *
 * `segments` is exactly 8 entries (BCH's 60s = 8×8s anchor). Each
 * entry carries { dialogue, sceneDirection, emotionalBeat? }.
 * Dialogue is 20-24 spoken words (Veo Lite 8s @ 170wpm calibration
 * from packages/ai-providers/src/veo-lite-segment-prompt.ts).
 *
 * Kept in packages/jobs (not @mbb/ai-providers) because it wraps a
 * job-flow contract, not a reusable primitive.
 */
import { CharacterLockSchema, FALLBACK_CHARACTER_LOCK, type CharacterLock } from '@mbb/shared';
import { z } from 'zod';

export const POLISH23_SEGMENT_COUNT = 8;
export const POLISH23_CLIP_SECONDS = 8;

export const SegmentSpecSchema = z.object({
  dialogue: z.string().min(1),
  sceneDirection: z.string().min(1),
  emotionalBeat: z.string().optional(),
});

export const AdSpecSchema = z.object({
  character_lock: CharacterLockSchema,
  segments: z.array(SegmentSpecSchema).length(POLISH23_SEGMENT_COUNT),
});

export type SegmentSpec = z.infer<typeof SegmentSpecSchema>;
export type AdSpec = z.infer<typeof AdSpecSchema>;

/**
 * System prompt for the Claude ad-spec pass. Anchored on the
 * Polish-21.0.7 Linda pattern (7-block Nano Banana composer): the
 * character description gets an ANONYMOUS-not-ATTRACTIVE
 * intentional-mediocrity framing, the anti-celebrity buckets are
 * named (not vague), and physical-feature bullets are itemized so
 * the CharacterLockSchema can validate wholesale.
 *
 * Word-count discipline is stated as a hard invariant so Claude
 * won't under-fill (17w = dead air) or over-fill (28w = rushed).
 */
export const POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT = `You are an ad-spec composer for a UGC video ad generator.

INPUT: a transcript / description of a source ad (usually a real
person selling a product on TikTok / Instagram Reels).

OUTPUT: ONE JSON object, no prose, no markdown fences, matching this schema:

{
  "character_lock": {
    "name": string,                            // fictional first name matching demographic
    "age": integer (18-90),
    "nationality": string,                     // e.g. "American", "Brazilian"
    "gender": "male" | "female",
    "demographic_role": string,                // "suburban grandmother", "working dad", "college student"
    "hair_bullet": string,                     // "- Shoulder-length salt-and-pepper hair, natural waves"
    "eye_asymmetry_bullet": string,            // "- Slightly uneven eye line, natural asymmetry"
    "nose_bullet": string,                     // "- Ordinary nose, slight bump at the bridge"
    "mouth_bullet": string,                    // "- Thin lips, natural resting expression"
    "eye_color_and_age_detail": string,        // "- Warm hazel eyes with faint crow's feet"
    "jaw_bullet": string,                      // "- Soft jawline, some loosening with age"
    "face_shape_bullet": string,               // "- Oval face, unremarkable proportions"
    "clothing_bullet": string,                 // "- Clothing: Faded navy cotton crewneck"
    "setting_paragraph": string,               // "Sitting at her kitchen table in a suburban split-level..."
    "skin_age_appropriate_detail": string,     // one sentence of ordinary age-appropriate skin detail
    "skin_color_for_stubble": "none" | "black" | "brown" | "blonde" | "gray",
    "anti_celeb_actress_examples": string[],   // 8-12 famous names Claude MUST steer AWAY from
    "anti_celeb_news_examples": string[],      // 4-6 news-anchor names
    "anti_celeb_politician_examples": string[] // 2-4 politician names
  },
  "segments": [
    // EXACTLY 8 items.
    {
      "dialogue": string,                      // 20-24 spoken words. HARD LIMIT. Under-fill → dead air. Over-fill → clipped speech.
      "sceneDirection": string,                // one sentence: what the character is doing / holding / gesturing. NOT appearance.
      "emotionalBeat"?: string                 // optional: "curious", "reassured", "frustrated"
    },
    // ...7 more...
  ]
}

CHARACTER RULES:
- The character must look ANONYMOUS, not ATTRACTIVE. Intentional
  mediocrity is the goal. A believable neighbor, not a model.
- Steer the character AWAY from every name in
  anti_celeb_actress_examples / news_examples / politician_examples.
- Physical features must be deliberately asymmetric and ordinary.
  Bullets lead with "- " so downstream composers can splice them
  verbatim into image-model prompts.

SEGMENT RULES:
- EXACTLY 8 segments. Not 7, not 9.
- Each dialogue is 20-24 words. Count spoken words INSIDE quotes
  only (attribution / stage directions don't count).
- Together the 8 segments form ONE coherent 60-second UGC ad
  (hook → problem → solution → benefits → CTA arc, adapted from
  the source concept).
- sceneDirection MUST be about action/framing, NEVER re-describe
  the character's face/hair/clothing — those live in character_lock
  and are threaded automatically.

CRITICAL:
- Return the JSON object AND NOTHING ELSE. No leading "Here is",
  no trailing "Let me know if you need adjustments", no markdown
  fences. If you cannot fit the schema, return your best-effort
  JSON — the caller has a fallback.`;

export function composePolish23AdSpecUserPrompt(sourceConceptText: string): string {
  return `Source concept to adapt:

<<<
${sourceConceptText}
>>>

Emit the JSON object per the schema above.`;
}

/**
 * Robust parse of the Claude ad-spec output.
 *
 * Handles three real-world Claude output surfaces:
 *   1. Clean JSON object (best case)
 *   2. Markdown-fenced JSON (Claude sometimes wraps despite
 *      instructions)
 *   3. Leading prose + JSON tail
 *
 * If parse+validate succeeds, returns the AdSpec. If ANY step fails,
 * returns null — the caller wholesale-falls-back to the Linda
 * anchor + a stock 8-segment scaffold so the pipeline can still
 * ship a first live variant while operator iterates on the prompt.
 */
export function parsePolish23AdSpec(claudeText: string | undefined | null): AdSpec | null {
  if (!claudeText) return null;

  // Strip markdown fences if present.
  const fenceStripped = claudeText.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  // Grab the first {...} substring — Claude sometimes prefaces with
  // "Here is the JSON:" no matter what the system prompt says.
  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const jsonCandidate = fenceStripped.slice(firstBrace, lastBrace + 1);

  let raw: unknown;
  try {
    raw = JSON.parse(jsonCandidate);
  } catch {
    return null;
  }
  const parsed = AdSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Wholesale fallback when Claude's response can't be parsed. Ships
 * a 8-segment Linda ad about a generic supplement so the pipeline
 * end-to-end plumbing still gets exercised on the first live test.
 * The dialogue lines are hand-calibrated to 20-24 words each so
 * the word-count check passes.
 */
export function fallbackPolish23AdSpec(): AdSpec {
  const character_lock: CharacterLock = FALLBACK_CHARACTER_LOCK;
  const segments: SegmentSpec[] = [
    {
      dialogue:
        'Okay so listen, my daughter finally got me to try this new supplement everyone in her mom group keeps talking about lately.',
      sceneDirection: 'Linda leans in slightly, eyebrows raised in mild disbelief.',
      emotionalBeat: 'skeptical',
    },
    {
      dialogue:
        "I told her look, I've tried every vitamin under the sun and honestly none of them do a single thing for my energy anymore.",
      sceneDirection: 'She waves a hand dismissively, then rests it on the kitchen counter.',
      emotionalBeat: 'weary',
    },
    {
      dialogue:
        'But she kept sending me these videos of other grandmas gardening again, playing with the grandkids, and I got a tiny bit curious.',
      sceneDirection: 'Linda tilts her head, a small reluctant smile forming.',
      emotionalBeat: 'curious',
    },
    {
      dialogue:
        "So I ordered one bottle just to prove her wrong and after about a week I noticed I wasn't reaching for coffee at three.",
      sceneDirection: 'She holds up one finger, then gestures toward an off-camera coffee mug.',
      emotionalBeat: 'surprised',
    },
    {
      dialogue:
        "By week two I was cleaning out the whole garage, something I'd been putting off for honestly probably two full years at this point.",
      sceneDirection: 'Linda gestures widely, sweeping her arm across an imagined space.',
      emotionalBeat: 'accomplished',
    },
    {
      dialogue:
        'My daughter noticed too. She said mom you sound different on the phone, more like yourself, and that got me kind of emotional.',
      sceneDirection: 'She touches her chest lightly, blinks a few times.',
      emotionalBeat: 'touched',
    },
    {
      dialogue:
        "Now I'm not here to tell you it's magic, I'm just telling you what happened to me and I think that's pretty fair.",
      sceneDirection: 'Linda holds up both palms in a "just being honest" gesture.',
      emotionalBeat: 'earnest',
    },
    {
      dialogue:
        "If you're my age and tired of feeling tired, go grab a bottle. There's a link right below this video. That's all I've got.",
      sceneDirection: 'She points downward toward the imagined CTA area, then gives a small nod.',
      emotionalBeat: 'reassured',
    },
  ];
  return { character_lock, segments };
}
