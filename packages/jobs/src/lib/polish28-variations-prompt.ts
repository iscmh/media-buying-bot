/**
 * Polish-28.3.0 Commit 85: Claude prompt to generate N DIVERSE persona +
 * script pairs for the Polish-28 variations mode.
 *
 * Input: full vision-analysis JSON of the source ad (transcript +
 * persona + emotional_arc + hook_structure + niche_category) + a
 * target variant count.
 *
 * Output: JSON array of exactly N `{persona, script}` objects, each
 * with a DIFFERENT persona (varied gender / age / ethnicity mix) and
 * a DIFFERENT script phrasing of the SAME core offer.
 *
 * Why: Polish-28.2.x clone mode produces one lip-synced replica of
 * the source actor. That's useful sometimes, but the actual A/B-test
 * pattern operators run on Meta is 5-10 distinct spokespeople all
 * pitching the same offer, so ads can be measured against different
 * demographic slices. This prompt is the batch-persona engine for
 * that.
 *
 * Downstream (in the worker):
 *   For each of the N returned pairs:
 *     - Nano Banana Pro renders a fresh character from `persona.look`
 *     - HeyGen voice matched to `persona.gender` + `persona.age_range`
 *     - HeyGen Avatar IV lip-syncs the character to `script` via
 *       native TTS (script + voice_id path — no external audio fetch)
 */

export const POLISH28_VARIATIONS_SYSTEM_PROMPT = `You are a UGC-ad variation generator for a Meta ads A/B-testing
pipeline. You take one source ad's vision analysis and produce a
diverse batch of N spokesperson variations. Each variation pitches
the SAME offer with a different persona speaking a distinct script.

# YOUR OUTPUT

A single JSON array of exactly N objects. Each object shape:

  {
    "persona": {
      "gender": "male" | "female",
      "age_range": string,           // e.g. "20s", "30s", "40-50", "60s"
      "ethnicity": string,           // e.g. "white", "black", "hispanic",
                                     // "asian", "middle_eastern", "mixed"
      "look": string                 // ONE short paragraph, 20-50 words,
                                     // describing the person's visual
                                     // appearance in enough detail for
                                     // an image model to render them
                                     // (hair, wardrobe, expression tone,
                                     // energy). NO gender / age / ethnicity
                                     // words in this field — those live in
                                     // their own slots above.
    },
    "script": string                 // The monologue THIS persona speaks.
                                     // First-person UGC style. Target
                                     // 900-1400 chars. HARD LIMIT 2200
                                     // — anything over gets truncated
                                     // at the last sentence boundary
                                     // before the cap.
  }

Emit ONE valid JSON array. NO surrounding text, NO markdown code fences,
NO commentary. If you can't produce N pairs, produce as many as you can
but still emit valid JSON.

# DIVERSITY REQUIREMENT

Personas MUST vary across the batch. Rules for a batch of N:

- Gender: aim for a roughly balanced split, not all-male / all-female
  unless the offer is gender-specific (e.g. women's-only supplements).
- Age: span at least 2 age buckets (e.g. 30s + 50s, or 20s + 40s + 60s).
- Ethnicity: at least 2 different ethnicity values when N >= 3.
- Look: distinct visual identities — different hair colors / styles,
  different wardrobe types (hoodie vs button-down vs t-shirt), different
  energy (calm vs animated).

Personas should still MATCH the offer's target demographic — a keto
supplement gets health-conscious middle-aged folks, not teenagers; a
crypto app gets a mix of 25-45yo tech-forward types, not retirees.
Use the offer's niche_category from the vision analysis to inform the
persona pool, but VARY within that pool.

# SCRIPT REQUIREMENTS

The scripts should be LIGHT variations of the source — close cousins,
not rewrites. The operator wants A/B tests where the OFFER, HOOK, and
STRUCTURE are held constant while the PERSONA voice varies subtly.
Aggressive script rewrites destroy the signal a test is meant to
measure (which persona converts on THIS message). Stay conservative.

Each script MUST:

1. FIRST-PERSON monologue only. This persona is speaking to camera.
   Never introduce a second speaker.

2. Preserve the source ad's structural beats VERBATIM where possible:
   - Same hook opening (rephrase only if it would sound unnatural in
     this persona's voice — e.g. an elderly persona wouldn't say
     "yo what's up guys")
   - Same offer / product / promise / stat / proof point
   - Same CTA (identical wording preferred — the CTA is what you're
     A/B-testing against, don't drift it across variants)
   - Same emotional arc (skeptical → surprised → convinced, or
     whatever the source uses)

3. Vary ONLY these per-persona details:
   - Vocal rhythm + filler words natural to the persona ("uhm", "like",
     "so" for younger; "you know", "well" for older)
   - Contractions vs full words (younger use more contractions)
   - 1-2 phrase substitutions if a source phrase is age/gender-coded
     ("dude" → "friend" for older; "back in my day" → "recently" for
     younger)
   - Sentence rhythm — shorter/punchier for young energetic personas,
     longer/measured for older reflective ones

4. Do NOT invent new anecdotes, examples, or claims. If the source
   says "I lost 15 pounds in 3 weeks," the variant says the same thing.
   Changing the number breaks the A/B test.

5. Do NOT change the CTA URL, product name, discount code, offer
   terms, or any specific number/fact from the source. Copy them
   character-for-character.

6. Length: match source length ±20% (aim within 200 chars of source
   script). HARD LIMIT 2200 chars — anything longer gets auto-truncated.

7. No appearance descriptions of the speaker (avatar handles that
   visually). Do not say "as a [gender]", "as a [ethnicity]", "in my
   [decade]", "as a bald guy", etc.

8. No nested quotes / third-party attribution patterns ("She told me
   'X'"). Paraphrase in indirect speech.

9. Natural TTS pacing. No complex bracketed dialogue.

RULE OF THUMB: if the operator ran the source script and your variant
side-by-side, 70-80% of the words should be IDENTICAL. Only the
phrasing that would sound wrong in this persona's mouth changes.

# EDGE CASES

- If the source vision analysis is thin (missing persona, thin
  transcript), invent plausible personas for the offer based on the
  niche_category alone. Do NOT refuse — produce the best batch you can.

- If N == 1, emit an array with a single element that's still a
  legitimate variation (not a copy of the source persona / script).

- N max is 10 per call. If asked for more, produce 10; the caller
  batches subsequent calls.
`;

export function composePolish28VariationsUserPrompt(
  sourceVisionAnalysisJson: string,
  variantCount: number,
): string {
  const clampedN = Math.max(1, Math.min(10, variantCount));
  return `Source-ad vision analysis:

<<<
${sourceVisionAnalysisJson}
>>>

Produce exactly ${clampedN} persona + script variation pairs per the
constraints in the system prompt. Emit the JSON array only — no
prose, no code fences.`;
}

/**
 * Parsed shape of one variation entry from Claude's JSON output.
 * The worker validates against this shape before dispatching per-variant
 * generations.
 */
export interface Polish28VariationEntry {
  persona: {
    gender: 'male' | 'female';
    age_range: string;
    ethnicity: string;
    look: string;
  };
  script: string;
}

/**
 * Parse Claude's raw JSON-array output into a validated array of
 * `Polish28VariationEntry`. Returns an object with `entries` (successful
 * parses, may be shorter than requested if Claude undershot or emitted
 * malformed entries) + `errors` (per-entry validation failures for
 * diagnostics). Throws only if the top-level parse fails entirely.
 */
export function parsePolish28VariationsResponse(rawText: string): {
  entries: Polish28VariationEntry[];
  errors: string[];
} {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Polish-28 variations Claude output is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `First 300 chars: ${JSON.stringify(cleaned.slice(0, 300))}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Polish-28 variations Claude output is not a JSON array (got ${typeof parsed}). ` +
        `First 300 chars: ${JSON.stringify(cleaned.slice(0, 300))}`,
    );
  }
  const entries: Polish28VariationEntry[] = [];
  const errors: string[] = [];
  parsed.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`[${i}] not an object`);
      return;
    }
    const o = item as Record<string, unknown>;
    const p = o['persona'];
    const s = o['script'];
    if (!p || typeof p !== 'object') {
      errors.push(`[${i}] missing persona object`);
      return;
    }
    const pObj = p as Record<string, unknown>;
    const gender = pObj['gender'];
    const age = pObj['age_range'];
    const eth = pObj['ethnicity'];
    const look = pObj['look'];
    if (gender !== 'male' && gender !== 'female') {
      errors.push(`[${i}] persona.gender not male/female (got ${JSON.stringify(gender)})`);
      return;
    }
    if (typeof age !== 'string' || !age.trim()) {
      errors.push(`[${i}] persona.age_range missing/empty`);
      return;
    }
    if (typeof eth !== 'string' || !eth.trim()) {
      errors.push(`[${i}] persona.ethnicity missing/empty`);
      return;
    }
    if (typeof look !== 'string' || look.trim().length < 20) {
      errors.push(`[${i}] persona.look missing or too short (need >=20 chars)`);
      return;
    }
    if (typeof s !== 'string' || s.trim().length < 200) {
      errors.push(`[${i}] script missing or too short (need >=200 chars)`);
      return;
    }
    // Polish-28.3.2 Commit 87: raised hard cap 1500 -> 2200 (real
    // HeyGen Avatar IV native TTS accepts much longer; the old 1500
    // was a leftover from the MakeUGC voice_script cap). Also
    // auto-truncate rather than reject — Claude drifts on length
    // and rejecting a whole entry over ~100 chars overshoot means
    // zero variants ship. Truncate at the last sentence boundary
    // before the cap so we preserve the CTA structure.
    const HARD_SCRIPT_CAP = 2200;
    let finalScript = s.trim();
    if (finalScript.length > HARD_SCRIPT_CAP) {
      const truncated = finalScript.slice(0, HARD_SCRIPT_CAP);
      // Try to break at the last sentence terminator (. ! ?) before the cap.
      const lastSentenceEnd = Math.max(
        truncated.lastIndexOf('. '),
        truncated.lastIndexOf('! '),
        truncated.lastIndexOf('? '),
        truncated.lastIndexOf('.\n'),
        truncated.lastIndexOf('!\n'),
        truncated.lastIndexOf('?\n'),
      );
      if (lastSentenceEnd > HARD_SCRIPT_CAP * 0.7) {
        finalScript = truncated.slice(0, lastSentenceEnd + 1).trim();
      } else {
        // No good sentence boundary — hard-truncate + trailing period
        finalScript =
          truncated
            .trim()
            .replace(/[,;:]?\s*\S*$/, '')
            .trim() + '.';
      }
      errors.push(
        `[${i}] script auto-truncated ${s.length} -> ${finalScript.length} chars (soft warn, entry kept)`,
      );
    }
    entries.push({
      persona: {
        gender,
        age_range: age.trim(),
        ethnicity: eth.trim(),
        look: look.trim(),
      },
      script: finalScript,
    });
  });
  return { entries, errors };
}
