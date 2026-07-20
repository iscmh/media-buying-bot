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

/**
 * Polish-23 Commit 3.0.23: Google Veo's TTS model rejects dialogue
 * with nested quotes / mid-clip voice switches. First 6/8 run of
 * job 03a…64 died on clip 6 dialogue:
 *
 *   "So I hit up my old buddy Frank who's been retired five years.
 *    He said, 'David, just enjoy it. But my brain kept buzzing.'"
 *
 * Google Veo error: "The Google model was unable to generate audio
 * for this request. Please try a different prompt."
 *
 * Root cause: the ' … ' bracketed third-party speech ("David, just
 * enjoy it. But my brain kept buzzing.") forces Google's TTS to
 * render a second voice mid-clip, which it can't do reliably.
 *
 * These regex patterns catch nested-quote shapes we've seen fail:
 *   1. Straight double quotes         "..." (3+ chars)
 *   2. Curly double quotes            "…" (3+ chars, U+201C U+201D)
 *   3. Curly single quotes            '…' (5+ chars, U+2018 U+2019)
 *   4. Attribution verb + straight    said, 'David, …'
 *      single-quoted proper-noun-ish  told, 'Frank, …'
 *      content (capital-letter start)
 *
 * The attribution+single-quote pattern deliberately requires a
 * CAPITAL letter after the opening apostrophe so contraction
 * sequences like "I said I'm fine and she said that's it" don't
 * false-positive (both apostrophes come from contractions).
 *
 * Exported so tests can pin the exact list.
 */
export const POLISH23_NESTED_QUOTE_PATTERNS: readonly RegExp[] = [
  /"[^"]{3,}"/,
  /“[^“”]{3,}”/,
  /‘[^‘’]{5,}’/,
  // Attribution verb + optional recipient word ("me", "her", "us"…)
  // + optional punctuation + whitespace + straight-single-quoted
  // content that STARTS WITH A CAPITAL LETTER and is 5+ chars long.
  // The capital-letter gate keeps contraction pairs like "I said I'm
  // fine and she said that's all" from false-positiving (all
  // apostrophes are followed by lowercase letters). The optional
  // recipient word handles "He told me, 'Frank told me to enjoy it'"
  // shape from the operator's clip-6 failure family.
  //
  // NO /i flag on purpose — JS regex case-insensitive mode folds
  // [A-Z] to also match a-z, which would defeat the capital gate.
  // Verbs stay lowercase because mid-sentence UGC dialogue always
  // has attribution verbs in lowercase ("He said," never "He SAID,").
  /\b(said|says|say|told|tells|asked|asks|replied|replies|shouted|whispered|yelled|answered|answers)\b\s*(?:\w+\s*)?[,:]?\s*'[A-Z][^']{5,}'/,
];

export function containsQuotedThirdPartySpeech(dialogue: unknown): boolean {
  if (typeof dialogue !== 'string' || dialogue.length === 0) return false;
  return POLISH23_NESTED_QUOTE_PATTERNS.some((p) => p.test(dialogue));
}

export const SegmentSpecSchema = z.object({
  dialogue: z
    .string()
    .min(1)
    .refine((d) => !containsQuotedThirdPartySpeech(d), {
      message:
        'dialogue contains quoted third-party speech (nested quotes / attribution+quote pattern). ' +
        'Google Veo TTS rejects mid-clip voice switches. Rewrite as first-person paraphrase.',
    }),
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
 * Polish-23 Commit 3.0.28: the Linda anchor in Claude's SYSTEM
 * prompt was overpowering the PERSONA MIRROR HARD CONSTRAINT in
 * the USER message. SQL forensics (metadata.
 * polish23_claude_parsed_character_lock) confirmed the mirror
 * reached Claude with all imperative language intact, but Claude
 * still returned Linda — Claude's architecture weighs system
 * prompt > user instructions when they conflict.
 *
 * Fix: PERSONA-MIRROR MODE. When the worker knows a persona is
 * available, the system prompt sent to Claude OMITS every Linda-
 * shaped bullet example and every reference to "Linda" as a
 * template. Only the schema shapes, the PERSONA MIRROR PRIORITY
 * imperative, and the rules survive. With no Linda in the system
 * prompt, there's no template to pull Claude away from the mirror.
 *
 * Fallback mode (no persona) keeps the Linda anchor as the
 * structural template so pre-vision-analysis flows still work.
 *
 * getPolish23AdSpecSystemPrompt() is the new entrypoint. The old
 * constant POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT is preserved as
 * the fallback-mode default so any external caller / test still
 * compiles and runs.
 */
export interface Polish23AdSpecSystemPromptOptions {
  /**
   * True when the worker has extracted a vision persona and is
   * about to prepend a "===== PERSONA MIRROR (HARD CONSTRAINT)
   * =====" block to the user message. The system prompt returned
   * in this mode intentionally OMITS the Linda-shaped bullet
   * examples so Claude's system-prompt attention doesn't
   * override the user-message mirror.
   */
  hasPersonaMirror: boolean;
}

export function getPolish23AdSpecSystemPrompt(opts: Polish23AdSpecSystemPromptOptions): string {
  return opts.hasPersonaMirror
    ? POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT
    : POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT;
}

// -------------------------------------------------------------------
// Persona-mirror mode: NO Linda bullet examples, NO Linda template
// references. Only schema shapes + PERSONA MIRROR imperatives + rules.
// -------------------------------------------------------------------

export const POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT = `You are an ad-spec composer for a UGC video ad generator.

INPUT: a transcript / description of a source ad + a PERSONA MIRROR
(HARD CONSTRAINT) block extracted from the source video's vision
analysis. The mirror block is AUTHORITATIVE for the character
identity.

OUTPUT: ONE JSON object, no prose, no markdown fences, matching this schema:

{
  "character_lock": {
    "name": string,
    "age": integer (18-90),
    "nationality": string,
    "gender": "male" | "female",
    "demographic_role": string,
    "hair_bullet": string,
    "eye_asymmetry_bullet": string,
    "nose_bullet": string,
    "mouth_bullet": string,
    "eye_color_and_age_detail": string,
    "jaw_bullet": string,
    "face_shape_bullet": string,
    "clothing_bullet": string,
    "setting_paragraph": string,
    "skin_age_appropriate_detail": string,
    "skin_color_for_stubble": "none" | "black" | "brown" | "blonde" | "gray",
    "anti_celeb_actress_examples": string[],
    "anti_celeb_news_examples": string[],
    "anti_celeb_politician_examples": string[],
    "body_invariant_bullet": string,
    "setting_invariant_bullet": string
  },
  "segments": [
    // EXACTLY 8 items.
    { "dialogue": string, "sceneDirection": string, "emotionalBeat"?: string }
    // ...7 more...
  ]
}

PERSONA-MIRROR MODE (Polish-23 Commit 3.0.28 — HARD CONSTRAINT):
- This system prompt intentionally OMITS every character-template
  example, every default identity, and every previously-used
  character name. The character comes ENTIRELY from the
  "===== PERSONA MIRROR (HARD CONSTRAINT) =====" block at the top
  of the user message.
- Rules — each is a HARD CONSTRAINT, a wrong output on any of them
  is a total pipeline failure:
  1. character_lock.gender MUST equal the mirror's gender field
     verbatim ("male" or "female"). No exceptions.
  2. character_lock.age MUST fall inside the mirror's age_range
     (e.g. "60s" → integer between 60 and 69 inclusive).
  3. character_lock.nationality + demographic_role MUST describe
     someone matching the mirror's gender + ethnicity + age.
  4. character_lock.name MUST be a common first name for the
     mirror's gender + ethnicity. Do NOT reuse names from any
     prior response.
  5. Every physical bullet (hair_bullet, eye_asymmetry_bullet,
     nose_bullet, mouth_bullet, eye_color_and_age_detail,
     jaw_bullet, face_shape_bullet, skin_age_appropriate_detail)
     MUST describe features consistent with the mirror's persona.
     A gray-haired 60yo white male's hair_bullet reads "short
     gray hair, receding hairline" or similar — NEVER a bullet
     borrowed from a different demographic.
  6. clothing_bullet MUST match the mirror's "look" description
     (e.g. mirror says "gray hair, light green long-sleeve" →
     clothing_bullet references a light green long-sleeve shirt).
  7. setting_paragraph MUST match the mirror's inferred setting
     when the vision analysis provides one; otherwise a plausible
     setting for the demographic.
  8. anti_celeb_actress_examples, anti_celeb_news_examples,
     anti_celeb_politician_examples MUST list famous names
     matching the mirror's gender + ethnicity + age bracket
     (a 60yo white male mirror → male actors / anchors /
     politicians of that bracket, NOT female).

CHARACTER RULES (persona-mirror mode):
- The character must look ANONYMOUS, not ATTRACTIVE. Intentional
  mediocrity is the goal. A believable neighbor, not a model.
- Steer the character AWAY from every name in
  anti_celeb_actress_examples / news_examples / politician_examples.
- Physical features must be deliberately asymmetric and ordinary.
  Bullets lead with "- " so downstream composers can splice them
  verbatim into image-model prompts.
- body_invariant_bullet and setting_invariant_bullet MUST include
  the word "SAME" AT LEAST TWICE — they're the anchors that
  prevent clip-to-clip drift. Repeat "SAME weight, SAME
  proportions" and "SAME chair, SAME position" verbatim in these
  fields. Downstream Veo weights REPETITION heavily.

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

DIALOGUE RULES (Polish-23 Commit 3.0.23 — Google Veo TTS constraint):
- Every segment's dialogue is spoken in the character's OWN voice
  ONLY. Single continuous first-person monologue per clip. No
  character switches mid-segment.
- NEVER quote another person's speech. NO nested quotes of any kind
  — no straight double quotes, no curly quotes, no single-quoted
  bracketed speech.
- NEVER use dialogue attribution patterns that introduce a second
  speaker. Avoid ALL of these shapes:
    BAD: He said, "Just enjoy it."
    BAD: She told me, "You'll be fine."
    BAD: He said, 'David, just enjoy it. But my brain kept buzzing.'
- If the character REFERS to another person's words, PARAPHRASE in
  indirect / reported speech (no bracketed quoted content). Example:
    GOOD: "Frank told me to just enjoy retirement, but my brain kept buzzing."
- Rationale: Google Veo's TTS model rejects clips with nested-quote
  dialogue. A downstream Zod validator enforces this at parse
  time; violating dialogue causes wholesale fallback.

CRITICAL:
- Return the JSON object AND NOTHING ELSE. No leading "Here is",
  no trailing "Let me know if you need adjustments", no markdown
  fences. If you cannot fit the schema, return your best-effort
  JSON — the caller has a fallback.`;

// -------------------------------------------------------------------
// Fallback mode: original Polish-21.0.7 Linda-anchored system prompt.
// Preserved for backward compatibility + used when NO persona mirror
// is available (concept has no vision analysis extracted yet).
// -------------------------------------------------------------------

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
 *
 * Polish-23 Commit 3.0.28 note: this constant is now the FALLBACK
 * mode. Callers with a persona mirror should use
 * getPolish23AdSpecSystemPrompt({ hasPersonaMirror: true }) instead
 * so Claude's system-prompt Linda attention doesn't override the
 * user-message mirror. See
 * POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT above.
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
    "anti_celeb_politician_examples": string[], // 2-4 politician names
    "body_invariant_bullet": string,           // one sentence: build + weight + shoulder width. Leads with body type words: "Medium build, average weight for age…". Includes "SAME weight, SAME body proportions across every clip." NO changes clip-to-clip.
    "setting_invariant_bullet": string         // one sentence: SPECIFIC seated position + SPECIFIC visible background objects + SPECIFIC light direction. Example: "Seated upright at kitchen table with a white ceramic coffee mug in front of her, morning window light from off-camera right — SAME chair, SAME table position, SAME mug placement across every clip."
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

PERSONA MIRROR PRIORITY (Polish-23 Commit 3.0.25-26 — AUTHORITATIVE):
- If the user message contains a "===== PERSONA MIRROR (HARD
  CONSTRAINT) =====" block, that block is the AUTHORITATIVE SOURCE
  of the character_lock's identity. Read every "PER-FIELD
  REQUIREMENTS" bullet as a Zod-style invariant — violate one and
  the downstream pipeline fails.
- character_lock.gender in your output MUST equal the mirror's
  gender field verbatim ("male" or "female"). No exceptions.
- character_lock.age MUST fall inside the mirror's age_range.
- character_lock.demographic_role, name, hair/eye/nose/etc. bullets
  MUST reflect the mirror's persona — not the Linda default, not
  any other default from previous responses.
- LINDA ANCHOR ROLE: the Linda-shaped bullet examples elsewhere in
  this system prompt (68yo American female suburban grandmother,
  "Shoulder-length salt-and-pepper hair", "Faded navy cotton
  crewneck", etc.) are a STRUCTURAL TEMPLATE — they show the
  SHAPE + LEVEL OF DETAIL each bullet must have. They are NOT the
  identity to copy. The character's actual identity — gender, age,
  ethnicity, name, look — comes from the PERSONA MIRROR block.
  Linda is a stylistic guide only, NOT an identity source.
- If PERSONA MIRROR says gender=male, output character_lock.gender
  = "male". If it says age_range=60s, output character_lock.age
  should be a 60-69 integer. If it says ethnicity=white, the hair
  / skin / demographic_role bullets should describe a white male
  in his 60s — not a suburban grandmother.
- If NO PERSONA MIRROR block is present, fall back to inferring
  character demographics from the source concept transcript.

CHARACTER RULES:
- The character must look ANONYMOUS, not ATTRACTIVE. Intentional
  mediocrity is the goal. A believable neighbor, not a model.
- Steer the character AWAY from every name in
  anti_celeb_actress_examples / news_examples / politician_examples.
- Physical features must be deliberately asymmetric and ordinary.
  Bullets lead with "- " so downstream composers can splice them
  verbatim into image-model prompts.
- body_invariant_bullet and setting_invariant_bullet MUST include
  the word "SAME" AT LEAST TWICE — they're the anchors that
  prevent clip-to-clip drift (first end-to-end Polish-23 run
  showed body-shape + setting drift). Repeat "SAME weight, SAME
  proportions" and "SAME chair, SAME position" verbatim in these
  fields. Downstream Veo weights REPETITION heavily.

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

DIALOGUE RULES (Polish-23 Commit 3.0.23 — Google Veo TTS constraint):
- Every segment's dialogue is spoken in the character's OWN voice
  ONLY. Single continuous first-person monologue per clip. No
  character switches mid-segment.
- NEVER quote another person's speech. NO nested quotes of any kind
  — no straight double quotes, no curly quotes, no single-quoted
  bracketed speech.
- NEVER use dialogue attribution patterns that introduce a second
  speaker. Avoid ALL of these shapes:
    BAD: He said, "Just enjoy it."
    BAD: She told me, "You'll be fine."
    BAD: He said, 'David, just enjoy it. But my brain kept buzzing.'
- If the character REFERS to another person's words, PARAPHRASE in
  indirect / reported speech (no bracketed quoted content). Example:
    GOOD: "Frank told me to just enjoy retirement, but my brain kept buzzing."
    BAD:  "Frank said, 'David, just enjoy it. But my brain kept buzzing.'"
- Rationale: Google Veo's TTS model rejects clips with nested-quote
  dialogue — it can't switch voices mid-8s-clip reliably. A clip
  that violates this rule fails with "The Google model was unable
  to generate audio for this request." A downstream Zod validator
  enforces this at parse time; violating dialogue causes wholesale
  fallback to the Linda stock ad.

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
 *
 * Polish-23 Commit 3.0.1: to diagnose parse failures without a
 * redeploy, callers should ALSO run diagnosePolish23AdSpecParseFailure
 * with the same text and log the returned reason. That helper
 * mirrors this function's steps and names the specific failure mode
 * (empty / no-JSON-braces / json-parse-error / schema-mismatch)
 * without changing this function's { AdSpec | null } signature — the
 * existing callers + tests keep working.
 */
export function parsePolish23AdSpec(claudeText: string | undefined | null): AdSpec | null {
  const diag = diagnosePolish23AdSpecParseFailure(claudeText);
  return diag.ok ? diag.data : null;
}

/**
 * Polish-23 Commit 3.0.1: diagnostic-quality parse. Same steps as
 * parsePolish23AdSpec, but the return shape names WHY parsing failed.
 * Step A's worker logs the reason so a future parse failure is
 * traceable in Inngest without a redeploy.
 *
 * Failure modes:
 *   - 'empty'              — claudeText was null / undefined / ''
 *   - 'no-json-braces'     — no {...} substring found
 *   - 'json-parse-error'   — the JSON.parse call threw (syntax error)
 *   - 'schema-mismatch'    — JSON parsed but Zod rejected (missing
 *                            fields, wrong segment count, out-of-range
 *                            enum, etc.); `detail` carries the first
 *                            few zod issues so the operator can see
 *                            which schema field caused the reject
 */
export type DiagnosePolish23AdSpecResult =
  | { ok: true; data: AdSpec }
  | {
      ok: false;
      reason: 'empty' | 'no-json-braces' | 'json-parse-error' | 'schema-mismatch';
      detail?: string;
    };

export function diagnosePolish23AdSpecParseFailure(
  claudeText: string | undefined | null,
): DiagnosePolish23AdSpecResult {
  if (!claudeText) return { ok: false, reason: 'empty' };

  const fenceStripped = claudeText.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return { ok: false, reason: 'no-json-braces' };
  }
  const jsonCandidate = fenceStripped.slice(firstBrace, lastBrace + 1);

  let raw: unknown;
  try {
    raw = JSON.parse(jsonCandidate);
  } catch (e) {
    return {
      ok: false,
      reason: 'json-parse-error',
      detail: (e as Error).message.slice(0, 400),
    };
  }
  const parsed = AdSpecSchema.safeParse(raw);
  if (!parsed.success) {
    // Surface the first 3 zod issues so operators see exactly which
    // schema field mismatched (e.g. "segments must contain exactly 8
    // element(s)"). Keeps log lines readable.
    const issues = parsed.error.issues.slice(0, 3).map((i) => {
      const path = i.path.join('.') || '(root)';
      return `${path}: ${i.message}`;
    });
    return {
      ok: false,
      reason: 'schema-mismatch',
      detail: issues.join(' | ').slice(0, 800),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Polish-23 Commit 3.0.2: per-segment validity check. A segment
 * is valid when it's a non-null object with non-empty dialogue AND
 * non-empty sceneDirection strings. Exported so the safety-net
 * coalescer + the pre-Step-C assertion share one definition.
 */
export function isValidSegment(seg: SegmentSpec | undefined | null): seg is SegmentSpec {
  if (seg == null) return false;
  if (typeof seg.dialogue !== 'string' || seg.dialogue.trim().length === 0) return false;
  if (typeof seg.sceneDirection !== 'string' || seg.sceneDirection.trim().length === 0)
    return false;
  // Polish-23 Commit 3.0.23: nested-quote dialogue kills Google's
  // Veo TTS. Belt-and-suspenders with the Zod refine — the schema
  // already rejects, but coalescer paths that see a manually-
  // constructed SegmentSpec would otherwise let it through.
  if (containsQuotedThirdPartySpeech(seg.dialogue)) return false;
  return true;
}

/**
 * Polish-23 Commit 3.0.2: safety-net coalescer. Belt-and-suspenders
 * on the critical path where empty prompts → kie.ai 400s.
 *
 * Contract:
 *   - parsed == null → wholesale fallback (all 8 stock segments).
 *     `wholesaleFallback: true`, `segmentFallbackIndices: []`
 *   - parsed != null with all segments valid → identity return,
 *     `segmentFallbackIndices: []`, `wholesaleFallback: false`
 *   - parsed != null with SOME segments invalid → per-index
 *     backfill from the fallback, index of each replaced slot
 *     recorded in `segmentFallbackIndices`
 *
 * Since the parser (Zod) already enforces every segment's
 * dialogue.min(1) + sceneDirection.min(1), the per-index backfill
 * path is dead code today — but the operator's Commit 3.0.1
 * first-live report suggested a state that should have been
 * unreachable did surface anyway. This coalescer is future-proof
 * defense: any later schema loosening, in-memory mutation, or
 * Inngest-cache drift lands here instead of at Veo submit.
 */
export interface CoalescedAdSpec {
  adSpec: AdSpec;
  segmentFallbackIndices: number[];
  wholesaleFallback: boolean;
}

export function coalesceAdSpecWithFallback(
  parsed: AdSpec | null,
  fallback: AdSpec = fallbackPolish23AdSpec(),
): CoalescedAdSpec {
  if (parsed == null) {
    return { adSpec: fallback, segmentFallbackIndices: [], wholesaleFallback: true };
  }
  const segmentFallbackIndices: number[] = [];
  const segments: SegmentSpec[] = [];
  for (let i = 0; i < POLISH23_SEGMENT_COUNT; i++) {
    const candidate = parsed.segments?.[i];
    if (isValidSegment(candidate)) {
      segments.push(candidate);
    } else {
      const fallbackSeg = fallback.segments[i]!;
      segments.push(fallbackSeg);
      segmentFallbackIndices.push(i);
    }
  }
  return {
    adSpec: { character_lock: parsed.character_lock, segments },
    segmentFallbackIndices,
    wholesaleFallback: false,
  };
}

/**
 * Polish-23 Commit 3.0.1: runtime invariant guard used pre-Step-C.
 * Post-Commit 3.0.2 the coalescer already backfills invalid
 * segments from the fallback, so this assertion should be dead
 * code in every healthy path. Kept as paranoid triple-check —
 * catches only "the fallback itself is corrupt" (which the test
 * suite pins as impossible) and gives a definitive diagnostic if
 * a future refactor breaks the contract.
 */
export function assertAllSegmentsValid(segments: SegmentSpec[]): void {
  if (!Array.isArray(segments)) {
    throw new Error(
      `[polish-23-worker] AdSpec.segments is not an array (${typeof segments}). ` +
        'Falling back to stock ad prevented; upstream drift.',
    );
  }
  if (segments.length !== POLISH23_SEGMENT_COUNT) {
    throw new Error(
      `[polish-23-worker] AdSpec.segments length ${segments.length} !== ${POLISH23_SEGMENT_COUNT}. ` +
        'Falling back to stock ad prevented; upstream drift.',
    );
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg == null) {
      throw new Error(
        `[polish-23-worker] AdSpec.segments[${i}] is ${seg === null ? 'null' : 'undefined'}. ` +
          'Refusing to submit Veo with an empty prompt.',
      );
    }
    if (typeof seg.dialogue !== 'string' || seg.dialogue.trim().length === 0) {
      throw new Error(
        `[polish-23-worker] AdSpec.segments[${i}].dialogue is empty or non-string. ` +
          'Refusing to submit Veo with an empty prompt.',
      );
    }
    if (typeof seg.sceneDirection !== 'string' || seg.sceneDirection.trim().length === 0) {
      throw new Error(
        `[polish-23-worker] AdSpec.segments[${i}].sceneDirection is empty or non-string. ` +
          'Refusing to submit Veo with an empty scene direction.',
      );
    }
    // Polish-23 Commit 3.0.23: last-chance guard against nested-quote
    // dialogue reaching Google Veo. Only reachable if the Zod refine
    // AND the coalescer's isValidSegment both let it through.
    if (containsQuotedThirdPartySpeech(seg.dialogue)) {
      throw new Error(
        `[polish-23-worker] AdSpec.segments[${i}].dialogue contains quoted third-party ` +
          `speech — Google Veo TTS will reject. Refusing to submit.`,
      );
    }
  }
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
