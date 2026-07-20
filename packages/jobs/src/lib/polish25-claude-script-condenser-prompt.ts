/**
 * Polish-25 Commit 2: Claude script condenser prompt.
 *
 * Rewrites the source-video vision analysis (transcript + persona +
 * emotional arc + hook + niche) into a SINGLE-CHARACTER first-person
 * monologue capped at 1500 chars, suitable for a pre-cast MakeUGC
 * avatar to speak. Preserves the source hook + emotional arc + niche
 * while eliminating everything that would break the pre-cast-avatar
 * pattern:
 *   - No appearance descriptions (avatar handles that visually)
 *   - No nested quotes / attribution patterns (Polish-23 Commit 3.0.23
 *     lesson — "He said 'X'" breaks TTS)
 *   - Single monologue, not multi-scene / multi-speaker
 *   - Natural TTS pacing (no complex bracketed dialogue)
 *
 * Downstream Zod validation:
 *   - MakeugcVoiceScriptSchema enforces <=1500 chars at submit time
 *   - containsQuotedThirdPartySpeech (Polish-23 Commit 3.0.23)
 *     rejects nested-quote output
 *   - Polish-25 own `assertPolish25ScriptOk` runs both AND rejects
 *     any obvious appearance-word residue
 */
import { z } from 'zod';
import { containsQuotedThirdPartySpeech } from './polish23-claude-adspec-prompt';

/**
 * Same 1500-char ceiling as MakeUGC's voice_script cap. Kept as a
 * separate constant so the condenser can target it independently of
 * the client-layer enforcement — safety margin in case Claude
 * overshoots.
 */
export const POLISH25_CONDENSED_SCRIPT_MAX_CHARS = 1500;

/**
 * Polish-25 Commit 4: CONTEXT-AWARE self-referential appearance
 * detection. Rejects appearance words ONLY when they describe the
 * SPEAKER THEMSELVES — not when they appear in natural dialogue
 * about third parties (family, friends, other characters).
 *
 * Why: Commit 2's list was word-only ("male", "wearing", "60s") and
 * false-positived on natural UGC scripts. Real evidence from job
 * 6ccf05d7 — a grandfather-perspective script about his
 * granddaughter ("She's seven. She doesn't know what things cost.
 * My granddaughter asked me...") was rejected as [appearance-leak]
 * even though nothing in it described the speaker's appearance.
 *
 * New rule: every pattern here requires a FIRST-PERSON marker
 * ("I", "I'm", "I am", "my", "at my", "as a") tied to an appearance
 * category (gender / ethnicity / age / hair / wardrobe). Third-
 * person pronouns (he / she / they) and family words (daughter,
 * granddaughter, friend) are FREE to appear anywhere.
 *
 * Trade-off: bare "60-year-old dude" (no first-person cue) no
 * longer flags. That's the operator-approved compromise — the risk
 * of Gemini emitting bare appearance strings describing the
 * speaker is lower than the observed false-positive rate on real
 * scripts. If a violation slips through, Claude has already
 * followed the system-prompt HARD CONSTRAINTS (see below) telling
 * it not to emit appearance descriptions in the first place.
 */
export const POLISH25_APPEARANCE_WORD_PATTERNS: readonly RegExp[] = [
  // Self-declared gender: "I'm a man", "I am a woman", "as a lady", "as a bald guy"
  /\bI\s*(?:'m|am)\s+(?:a\s+|an\s+)?(?:male|female|man|woman|guy|gal|lady|dude|gentleman|gentlemen|boy|girl)\b/i,
  /\bas\s+(?:a|an)\s+(?:[^.,;!?\n]{0,25}?\s)?(?:male|female|man|woman|guy|gal|lady|dude|gentleman|boy|girl)\b/i,

  // Self-declared age: "I'm 64", "I'm 64 years old", "I'm a 60-year-old",
  // "I'm in my 60s", "in my 60s", "at my age", "aged 64", "I'm elderly"
  /\bI\s*(?:'m|am)\s+(?:a\s+|an\s+)?\d{1,2}(?:\s+(?:year|years|yr|yrs)(?:\s+old)?)?\b/i,
  /\bI\s*(?:'m|am)\s+(?:a\s+|an\s+)?\d{1,2}[- ]year[- ]old\b/i,
  /\bI\s*(?:'m|am)\s+in\s+my\s+(?:early\s+|mid\s+|late\s+)?\d{1,2}s\b/i,
  /\bin\s+my\s+(?:early\s+|mid\s+|late\s+)?\d{1,2}s\b/i,
  /\bat\s+my\s+age\b/i,
  /\baged\s+\d{1,2}\b/i,
  /\bI\s*(?:'m|am)\s+(?:a\s+|an\s+)?(?:elderly|senior|retired\s+guy|retired\s+man|retired\s+woman|old\s+man|old\s+woman|young\s+man|young\s+woman|middle[- ]?aged)\b/i,

  // Self-declared ethnicity: "I'm white", "as a black woman", "I'm a hispanic guy"
  /\bI\s*(?:'m|am)\s+(?:a\s+|an\s+)?(?:white|caucasian|black|african[- ]?american|hispanic|latino|latina|asian|east[- ]?asian|south[- ]?asian|chinese|japanese|korean|indian|middle[- ]?eastern|arab|jewish|mixed[- ]?race|biracial|multiracial)\b/i,
  /\bas\s+(?:a|an)\s+(?:[^.,;!?\n]{0,20}?\s)?(?:white|caucasian|black|african[- ]?american|hispanic|latino|latina|asian|chinese|japanese|korean|indian|middle[- ]?eastern|arab|jewish|mixed[- ]?race|biracial|multiracial)(?:\s+(?:man|woman|male|female|guy|gal|lady|dude|gentleman|boy|girl))?\b/i,

  // Self-hair: "I have gray hair", "my gray hair", "I'm bald"
  /\b(?:I\s+have|I've\s+got|I've\s+had|I\s+got|my)\s+(?:[^.,;!?\n]{0,15}?\s)?(?:gray|grey|white|black|brown|blonde|blond|red|salt[- ]?and[- ]?pepper)[- ]?hair\b/i,
  /\bI\s*(?:'m|am)\s+(?:bald|balding|receding)\b/i,

  // Self-wardrobe: "I'm wearing", "dressed in", "my shirt"
  /\bI\s*(?:'m|am)\s+(?:wearing|dressed\s+in|dressed\s+as)\b/i,
  /\bwearing\s+my\s+(?:[^.,;!?\n]{0,15}?\s)?(?:shirt|blouse|sweater|hoodie|jacket|coat|dress|suit|tie|jeans|pants|skirt|scarf|hat|cap|glasses|sunglasses|jewelry|earrings|necklace)\b/i,
  /\bmy\s+(?:favorite\s+|old\s+|new\s+|nice\s+|blue\s+|red\s+|green\s+|black\s+|white\s+|gray\s+|grey\s+|brown\s+)?(?:shirt|blouse|sweater|hoodie|jacket|coat|suit|tie|scarf)\b/i,
];

export function containsPolish25AppearanceWords(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return POLISH25_APPEARANCE_WORD_PATTERNS.some((p) => p.test(text));
}

/**
 * Composite validator: script must be non-empty, <=1500 chars, contain
 * no nested-quote attribution patterns, and contain no appearance
 * leakage. Throws with a specific message for each failure so the
 * caller (worker) can log which invariant failed.
 */
export interface Polish25ScriptViolation {
  ok: false;
  reason: 'empty' | 'too-long' | 'nested-quotes' | 'appearance-leak';
  detail: string;
}

export type Polish25ScriptCheckResult = { ok: true; chars: number } | Polish25ScriptViolation;

export function checkPolish25CondensedScript(script: unknown): Polish25ScriptCheckResult {
  if (typeof script !== 'string' || script.trim().length === 0) {
    return { ok: false, reason: 'empty', detail: 'script is empty or non-string' };
  }
  if (script.length > POLISH25_CONDENSED_SCRIPT_MAX_CHARS) {
    return {
      ok: false,
      reason: 'too-long',
      detail: `script is ${script.length} chars — cap is ${POLISH25_CONDENSED_SCRIPT_MAX_CHARS}`,
    };
  }
  if (containsQuotedThirdPartySpeech(script)) {
    return {
      ok: false,
      reason: 'nested-quotes',
      detail: 'script contains nested-quote / attribution pattern (see Polish-23 Commit 3.0.23)',
    };
  }
  if (containsPolish25AppearanceWords(script)) {
    return {
      ok: false,
      reason: 'appearance-leak',
      detail:
        'script contains appearance words (gender / ethnicity / age / hair / wardrobe). ' +
        'Pre-cast avatar handles appearance; keep the script action + dialogue only.',
    };
  }
  return { ok: true, chars: script.length };
}

export function assertPolish25ScriptOk(script: string): void {
  const result = checkPolish25CondensedScript(script);
  if (!result.ok) {
    throw new Error(
      `Polish-25 condensed-script validation failed [${result.reason}]: ${result.detail}`,
    );
  }
}

/**
 * Zod schema for callers that thread the condensed script through a
 * parse boundary (e.g. the worker persisting to metadata).
 */
export const Polish25CondensedScriptSchema = z
  .string()
  .min(1)
  .max(POLISH25_CONDENSED_SCRIPT_MAX_CHARS)
  .refine((s) => !containsQuotedThirdPartySpeech(s), {
    message: 'condensed script contains nested-quote / attribution pattern',
  })
  .refine((s) => !containsPolish25AppearanceWords(s), {
    message: 'condensed script contains appearance words (avatar handles appearance visually)',
  });

/**
 * System prompt for the Claude script condensation pass. Operator-
 * tuned constraints reflected verbatim — do not paraphrase without
 * regression-pin updates.
 */
export const POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT = `You are a UGC-ad script condenser for a pre-cast avatar video pipeline.

INPUT: source-video vision analysis (JSON with transcript + persona
+ emotional_arc + hook_structure + niche_category + setting_details).

OUTPUT: ONE plaintext string — a single-character first-person
monologue the pre-cast avatar will speak. NOT JSON. NOT markdown.
Just the script text.

HARD CONSTRAINTS (each is a regression pin — violating one fails
Zod validation at the worker layer and forces a re-condense):

1. Length: MAXIMUM 1500 characters (MakeUGC voice_script cap).
   Target 1200-1450 chars — leaves safety margin.

2. Single voice: FIRST-PERSON monologue only. The character speaks
   throughout. Never introduce a second speaker.

3. No nested quotes: NEVER quote another person's speech. The
   patterns below all FAIL:
     BAD:  He said, "just enjoy retirement".
     BAD:  She told me, 'David, take it easy'.
     BAD:  My doctor said "you're fine".
   If the source references another person's words, PARAPHRASE in
   indirect speech:
     GOOD: My doctor told me everything was fine.
     GOOD: Frank told me to just enjoy retirement.

4. No SELF-APPEARANCE descriptions: the pre-cast avatar handles the
   SPEAKER's gender / ethnicity / age / hair / wardrobe VISUALLY.
   NEVER describe YOUR OWN appearance:
     BAD:  I'm a 60-year-old woman.
     BAD:  As a bald man, I know…
     BAD:  Wearing my favorite blue sweater…
     BAD:  I have gray hair and I've seen it all.
     BAD:  At my age, you learn…  (age self-reference)
   THIRD-PERSON dialogue about OTHER people is FINE — the constraint
   is on describing the speaker's own visual attributes, NOT on
   telling stories about family, friends, or events. These are all
   GOOD:
     GOOD: My granddaughter asked me if we could go to Disney World.
     GOOD: She's seven. She doesn't know what things cost.
     GOOD: My doctor told me everything was fine.
     GOOD: Frank said to just enjoy retirement.  (paraphrase, not quote)
   Focus the speaker's OWN words on ACTION and EMOTIONAL BEATS, and
   let third-person pronouns (he / she / they) and family words
   (daughter, son, granddaughter, friend, wife, husband) flow
   naturally when the story calls for them.

5. Preserve the source HOOK: whatever hook_structure the source
   used (question / statement / story / reveal) — mirror it in the
   opening sentence. This is what stops the scroll.

6. Preserve the source EMOTIONAL ARC: starting_emotion → key_beats
   → ending_emotion. The condensed script must land the same
   emotional trajectory in the same order.

7. Preserve the source NICHE / DOMAIN specifics: product names,
   proof points, category vocabulary. Do not sanitize technical
   claims into generic "this product" language — that's what makes
   UGC ads feel authentic.

8. Natural TTS pacing: use short sentences (10-20 words each).
   Contractions are fine. Avoid parenthetical asides, complex
   subordinate clauses, and multi-comma serial lists — those
   confuse TTS emphasis. One idea per sentence.

9. Return the SCRIPT AND NOTHING ELSE. No preamble ("Here is the
   condensed script:"), no trailing commentary, no markdown fences.
   Just the plaintext monologue.

FALLBACK BEHAVIOR: if the source is genuinely too complex to fit
in 1500 chars without dropping the hook + emotional arc + niche,
you MUST truncate MID-BENEFIT rather than mid-hook. Never drop the
hook. Never drop the final CTA / conclusion sentence.`;

export function composePolish25CondenserUserPrompt(sourceVisionAnalysis: string): string {
  return `Source vision analysis to condense:

<<<
${sourceVisionAnalysis}
>>>

Emit the condensed monologue per the constraints above.`;
}
