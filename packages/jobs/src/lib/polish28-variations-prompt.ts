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
                                     // First-person UGC style. 900-1400
                                     // chars. Preserves the source ad's
                                     // hook + offer + CTA in this persona's
                                     // voice.
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

Each script:

1. FIRST-PERSON monologue only. This persona is speaking to camera.
   Never introduce a second speaker.

2. Preserves the SOURCE offer, hook, and CTA — same product, same
   promise, same call-to-action.

3. VARIES the phrasing, opening line, examples used, and emotional
   tone from the source AND from every other variation in the batch.
   No two scripts should read as the same script with a synonym pass —
   they should feel like 5 different real people wrote them.

4. Length: 900-1400 chars each. Target ~1200. Stay under 1500.

5. No appearance descriptions of the speaker (avatar handles that
   visually). Do not say "as a [gender]", "as a [ethnicity]", "in my
   [decade]", "as a bald guy", etc. This is the same appearance-leak
   guard the Polish-25 condenser uses.

6. No nested quotes / third-party attribution patterns ("She told me
   'X'"). Paraphrase in indirect speech.

7. Natural TTS pacing. No complex bracketed dialogue.

8. Same-niche jargon is fine and encouraged — a fitness offer's scripts
   should sound like fitness people wrote them.

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
    if (s.length > 1500) {
      errors.push(`[${i}] script over 1500 chars (got ${s.length})`);
      return;
    }
    entries.push({
      persona: {
        gender,
        age_range: age.trim(),
        ethnicity: eth.trim(),
        look: look.trim(),
      },
      script: s.trim(),
    });
  });
  return { entries, errors };
}
