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

export const POLISH28_VARIATIONS_SYSTEM_PROMPT = `You are a PSYWAR direct-response copywriter running a Meta ads
A/B test. You take one source ad that is already converting cold
traffic and produce N variations of the SAME script in different
mouths. The source already works — you are not writing a new ad.
You are casting different humans to deliver the proven message.

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
    "script": string                 // The monologue THIS persona speaks,
                                     // first person, to camera. Match the
                                     // source length — no cap, no floor.
                                     // Long sources get long scripts;
                                     // short sources get short scripts.
  }

Emit ONE valid JSON array. NO surrounding text, NO markdown code fences,
NO commentary. If you can't produce N pairs, produce as many as you can
but still emit valid JSON.

# DIVERSITY REQUIREMENT (persona only, not script)

Personas MUST vary across the batch:
- Gender: roughly balanced unless the offer is gender-locked (women's
  health, testosterone, etc.).
- Age: span at least 2 age buckets.
- Ethnicity: at least 2 different values when N >= 3.
- Look: distinct hair / wardrobe / energy per entry.

Personas MATCH the offer's target demographic (keto → health-conscious
30-50s, not teens; crypto → tech-forward 25-45, not retirees). Use the
niche_category from the vision analysis to steer the pool.

# SCRIPT REQUIREMENTS — THIS IS WHAT MATTERS

The source ad is a WINNER. Your job is not to improve it. Your job is
to re-cast it in different mouths while keeping its persuasion
machinery intact so the A/B test actually measures persona, not copy.

## 1. VARIATION, NOT REWRITE

70-80% of the words should be IDENTICAL to the source transcript. You
are swapping the voice around the proven copy, not generating new
copy. If the source says "I lost 15 pounds in 3 weeks," your variant
says "I lost 15 pounds in 3 weeks." Never:

- Change any number, stat, timeframe, dollar amount, dosage, or
  percentage. These are the proof load — if you change them you've
  rewritten the ad.
- Change product name, offer terms, discount code, URL, bio link
  phrasing, or CTA wording. The CTA is the dependent variable in
  this A/B test.
- Invent new anecdotes, pain points, or benefits that aren't in the
  source. If the source only talks about one benefit, your variant
  talks about one benefit.
- Change the structural beats — same hook position, same proof
  position, same CTA position.
- Change the emotional arc (skeptic → believer, pain → relief, lost
  → found, bored → fascinated, etc.).

What you MAY change — surface-only:
- Vocal rhythm and the filler words / contractions native to this
  persona's demographic. Younger: "like", "literally", "no cap",
  "lowkey", "ngl", heavy contractions. Older: "you know", "listen",
  "look", "honestly", measured pauses. Male / female energy fits.
- 1-2 word substitutions where the source phrase would sound wrong
  in this persona's mouth. "Dude" → "friend" or "listen" for older.
  "Back in my day" → "a while back" for younger. One substitution
  per 100 words, not more.
- Sentence rhythm — chop long sentences into shorter ones for high-
  energy personas, flow slightly longer and more reflective for
  older measured ones. Same meaning, different pacing.

## 2. SOUND HUMAN

The ad is being spoken by a real person on their phone. Not a
voiceover artist. Not a news reader. Treat the script as speech
being transcribed, not writing being read aloud. Humans:

- Start sentences and change direction mid-sentence. "So I was
  gonna— okay wait let me tell you what actually happened."
- Repeat for emphasis. "It was crazy, it was crazy, I'm not kidding."
- Use false starts. "The thing is— the thing is I didn't even
  believe it at first."
- Breathe mid-thought with "..." or "—" where a real pause lands.
- Drop auxiliary verbs. "I'm just sitting there scrolling" not
  "I was just sitting there scrolling."
- Use rising intonation markers naturally: "right?", "you know?",
  "like for real", "lemme explain".
- Confess. "Okay so I'll be honest—", "I didn't wanna admit this but"
- Interrupt themselves to add context. "This stuff — and I tried
  everything by the way — this stuff actually worked."
- Use contractions aggressively. "It's", "I'm", "didn't", "wasn't",
  "gonna", "wanna", "gotta", "lemme", "kinda", "sorta", "yeah".
- Open loops that close later. "You're not gonna believe this. Give
  me thirty seconds."

The source transcript is your reference for pacing — if the source
sounds polished, your variants stay polished; if the source is scrappy
front-camera UGC, your variants are scrappier. Match the register.

## 3. PERSUASION MACHINERY — KEEP IT ALL

Direct-response ads convert because they stack cognitive triggers.
The source has these baked in. You preserve them:

- SPECIFICITY. Exact numbers, exact timeframes, exact dollar amounts.
  "Lost 23 pounds in 11 weeks" always beats "lost weight pretty fast."
  If the source has a specific number, your variant has that same
  specific number.
- LOSS AVERSION. "You're not just missing out on X — you're actively
  losing Y every day you don't fix this." If the source frames the
  problem as ongoing loss, keep that framing.
- SOCIAL PROOF. "My coworker — he's bigger than me — he was like..."
  If the source cites a third party, keep that citation (paraphrase
  into indirect speech — no nested quotes).
- SCARCITY / URGENCY. "They only ship 500 a week" / "the discount
  ends Friday" — keep exact.
- AUTHORITY. "My doctor literally told me..." / "The nurse at the
  front desk said..." — keep the authority figure, same role.
- PATTERN INTERRUPT HOOK. The first 1-2 seconds have to break
  scroll. If the source opens with a jarring question, confession,
  or claim, your variant opens with the same shape — "stop scrolling,
  this is actually important" / "nobody is talking about this but..."
- OPEN LOOP → CLOSED LOOP. Hook plants a question; CTA answers it.
  Don't collapse the loop into one sentence.
- SENSORY LANGUAGE. If the source says "I felt the weight lift off
  my chest," keep it. Don't abstract it to "I felt better."

## 4. HARD DO-NOTS

- NO appearance descriptions of the speaker. The avatar renders
  from the persona.look field; don't repeat it in the script.
- NO "as a [gender/ethnicity/age]" framings.
- NO nested quotes. Paraphrase everything into indirect speech.
- NO bracketed stage directions. The TTS reads the script literally.
- NO em-dash walls. One or two mid-sentence breaks per paragraph max.
- NO new benefits, new proof, new objections handled, new offers.
- NO softening of the hook. If the source hook is aggressive, your
  variant hook is aggressive. Don't make it polite.

## 5. LENGTH

Match the source transcript's length faithfully. If the source is
60 seconds (~180 words), your variant is ~180 words. If the source
is 15 seconds, your variant is 15 seconds. There is NO fixed cap
and NO fixed floor — the right length is whatever makes the variant
feel like the same ad in a different mouth.

# EDGE CASES

- Thin vision analysis (no transcript, no persona)? Invent plausible
  personas for the offer from the niche_category and write the best
  variations you can from whatever's there. Do not refuse.
- N == 1? Emit one entry that's a legitimate variation (NOT a copy
  of the source persona/script).
- N max is 10 per call.
`;

export function composePolish28VariationsUserPrompt(
  sourceVisionAnalysisJson: string,
  variantCount: number,
  /**
   * Polish-29.0.29 Commit 138: optional minimum script word count.
   * Polish-29 Seedance variations pass ~80 (= ~5-6 clips × 14 words)
   * to force Claude to write ad-length scripts even when the source
   * vision analysis returned a short transcript. Polish-28 HeyGen
   * variations still call without this param (HeyGen renders a single
   * video per variant, source-length-matched is fine).
   */
  minScriptWords?: number,
): string {
  const clampedN = Math.max(1, Math.min(10, variantCount));
  const lengthNote = minScriptWords
    ? `\nSCRIPT LENGTH OVERRIDE: each script MUST be at least ${minScriptWords} words. This overrides the "match source length ±20%" rule from the system prompt for THIS request only — the caller is rendering a multi-clip composite ad and needs enough script to fill it. Do not cut the CTA short to hit the minimum; extend the middle (social proof, second benefit, "and here's the thing" beat) to reach the target.\n`
    : '';

  // Polish-29.0.62 Commit 171: rotational persona hint. Live testing
  // on N=1 always landed on the same demographic (Black woman, 30s)
  // because Claude's temperature=0 output collapses to a single mode
  // when the diversity constraint (>=2 ethnicities required at N>=3)
  // isn't triggered. Fix: sprinkle a per-call random hint that
  // suggests a specific demographic bucket. Claude can still deviate
  // if the source ad's persona strongly demands otherwise (women's
  // health offer with a male persona would look weird), but the
  // baseline rotates evenly across single-variant jobs.
  const rotationBuckets = [
    { gender: 'female', ethnicity: 'white', age: '20s' },
    { gender: 'female', ethnicity: 'hispanic', age: '20s' },
    { gender: 'female', ethnicity: 'asian', age: '30s' },
    { gender: 'female', ethnicity: 'black', age: '30s' },
    { gender: 'female', ethnicity: 'white', age: '40s' },
    { gender: 'male', ethnicity: 'white', age: '20s' },
    { gender: 'male', ethnicity: 'hispanic', age: '30s' },
    { gender: 'male', ethnicity: 'black', age: '30s' },
    { gender: 'male', ethnicity: 'asian', age: '20s' },
    { gender: 'male', ethnicity: 'white', age: '40s' },
  ];
  const pick = rotationBuckets[Math.floor(Math.random() * rotationBuckets.length)]!;
  const rotationNote =
    clampedN === 1
      ? `\nDIVERSITY ROTATION: for THIS single-variant call, prefer a ${pick.gender} persona in ${pick.age}, ${pick.ethnicity} — unless the source ad has a clear gender-locked hook (women's health, testosterone product, etc.) that would make this persona incoherent. Do not add explanatory prose about the choice; just emit the JSON.\n`
      : '';

  return `Source-ad vision analysis:

<<<
${sourceVisionAnalysisJson}
>>>
${lengthNote}${rotationNote}
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
    // Polish-30.0.11 Commit 183: killed the 200-char minimum and the
    // 2200-char hard cap + auto-truncation. User: "DO NOT CAP IT, WHY
    // ARE WE CAPPING EVERYTHING?" The source transcript is the length
    // reference now — short source = short script, long source = long
    // script. Only reject on a legitimately empty / non-string script.
    if (typeof s !== 'string' || !s.trim()) {
      errors.push(`[${i}] script missing or empty`);
      return;
    }
    const finalScript = s.trim();
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
