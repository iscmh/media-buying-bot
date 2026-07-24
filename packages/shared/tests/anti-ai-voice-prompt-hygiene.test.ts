import { describe, expect, it } from 'vitest';
import { SHARED_ANTI_AI_VOICE_RULES, STATIC_WINNER_IMPORT_SYSTEM_PROMPT } from '../src/prompts';

/**
 * Polish-25.3 Commit 18b-hotfix-2: prompt hygiene regression pins.
 *
 * Two things to protect against silent regression:
 *
 *   1. The shared ruleset itself — a future edit that softens
 *      "NO em dashes" to "avoid em dashes when possible" would
 *      quietly stop enforcing the ban. Pin the exact hard-rule
 *      wording so anyone editing the ruleset has to update the
 *      test intentionally.
 *
 *   2. The static-ad prompt embeds the ruleset via string
 *      interpolation. If someone forks the prompt and forgets
 *      to include the ruleset, output quality degrades without
 *      any tsc error. Pin that both prompts contain the ruleset's
 *      unique marker strings.
 */
describe('Polish-25.3 Commit 18b-hotfix-2: SHARED_ANTI_AI_VOICE_RULES', () => {
  it('bans em dashes verbatim', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/NO em dashes/);
  });

  it('bans en dashes verbatim', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/NO en dashes/);
  });

  it('bans smart / curly quotes', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/smart quotes/i);
  });

  it('bans emojis unless the source used them', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/NO emojis unless/);
  });

  it('bans corporate hedging phrases by name (18b-hotfix-2 + Commit 20 extensions)', () => {
    // Regression pin: the exact hedging vocabulary. A future edit
    // that removes any of these from the banlist should surface
    // in code review, not silently soften the guard.
    for (const word of [
      // 18b-hotfix-2 originals
      'leverage',
      'unlock',
      'empower',
      'revolutionize',
      'cutting-edge',
      'game-changing',
      'unleash',
      'elevate',
      'seamless',
      // Commit 20 additions from DR research
      'streamline',
      'optimize',
      'next-level',
      'supercharge',
      'solutions',
      'innovative',
    ]) {
      expect(SHARED_ANTI_AI_VOICE_RULES).toContain(word);
    }
  });

  it('Commit 20: bans soft-close phrases (Halbert / Kennedy / Georgi / Settle canon)', () => {
    // Rule #12 — the DR banlist. Modern Meta ads use hard closes;
    // "check it out" and friends get scrolled.
    for (const phrase of [
      'check it out',
      'worth a look',
      'hard to argue with',
      'give it a try',
      'click here',
      'learn more',
      'find out how',
      'see for yourself',
      'why not try',
      'take a peek',
    ]) {
      expect(SHARED_ANTI_AI_VOICE_RULES).toContain(phrase);
    }
  });

  it('Commit 20: enforces "at least one variant opens with a number in first 40 chars" rule', () => {
    // Rule #13 — Meta's guaranteed-visible unit under 2026
    // Advantage+ delivery. Odd numbers read as more real.
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/first 40 characters/);
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/specific number/);
  });

  it('bans "Are you tired of" opener and other AI tells', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/Are you tired of/);
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/In today's fast-paced world/);
  });

  it('requires Title Case for headlines', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/Title Case/);
  });

  it('requires sentence case for body copy', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/sentence case/i);
  });

  it('names the direct-response beats (HOOK / PROBLEM / SOLUTION / PROOF / CTA)', () => {
    for (const beat of ['HOOK', 'PROBLEM', 'SOLUTION', 'PROOF', 'CTA']) {
      expect(SHARED_ANTI_AI_VOICE_RULES).toContain(beat);
    }
  });

  it('includes the contrarian framing toolkit', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/CONTRARIAN FRAMING TOOLKIT/);
  });

  it('includes at least one concrete GOOD vs BAD example pair', () => {
    expect(SHARED_ANTI_AI_VOICE_RULES).toMatch(/BAD.*GOOD|GOOD.*BAD/s);
  });

  it('does NOT itself contain an em dash in the CONSTRAINT text', () => {
    // The prose IN the rules can safely reference the character
    // once ("NO em dashes (—)") for definition. Beyond that single
    // definition use, an em dash in the prompt would model bad
    // output. Count occurrences and pin the ceiling at 1.
    const emDashCount = (SHARED_ANTI_AI_VOICE_RULES.match(/—/g) ?? []).length;
    expect(emDashCount).toBeLessThanOrEqual(1);
  });
});

describe('Polish-25.3 Commit 18b-hotfix-2: STATIC_WINNER_IMPORT_SYSTEM_PROMPT embeds the ruleset', () => {
  it('contains the HARD FORMATTING CONSTRAINTS marker from the shared ruleset', () => {
    // The interpolation would silently fail if someone forked
    // the prompt and dropped the ${SHARED_ANTI_AI_VOICE_RULES}
    // expression. Pin the unique heading string.
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(/HARD FORMATTING CONSTRAINTS/);
  });

  it('contains the CONTRARIAN FRAMING TOOLKIT block from the shared ruleset', () => {
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(/CONTRARIAN FRAMING TOOLKIT/);
  });

  it('names the direct-response BCH structure', () => {
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(/DIRECT-RESPONSE STRUCTURE/);
  });

  it('pins Meta hard-limit headlines at 40 chars max, primary at 125', () => {
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(/max 40 characters/);
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(/max 125 characters/);
  });
});

describe('Polish-25.3 Commit 20: STATIC_WINNER prompt has DR framework roster + anchor examples', () => {
  it('contains DR FRAMEWORK ROSTER section (adaptive selection mechanic)', () => {
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(/DR FRAMEWORK ROSTER/);
    // Adaptive selection language — pick that BEST amplify source
    // fidelity over framework diversity.
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(/Source fidelity beats framework diversity/);
  });

  it('names the 5 DR frameworks by canonical label', () => {
    // Regression pin: the roster stays exactly 5 named frameworks.
    // A future edit that adds a 6th or drops one has to update
    // this test intentionally.
    for (const framework of [
      'PAS re-cut',
      'Story-lead',
      'Contrarian / named-enemy',
      'Warning / loss-aversion',
      'Awareness-shift',
    ]) {
      expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toContain(framework);
    }
  });

  it('contains HOOK / AGITATION / PROOF / CLOSE PATTERN LIBRARY section', () => {
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(
      /HOOK \/ AGITATION \/ PROOF \/ CLOSE PATTERN LIBRARY/,
    );
    // Cites the practitioners the operator's research anchored to.
    for (const practitioner of ['Halbert', 'Kennedy', 'Schwartz', 'Georgi', 'Settle']) {
      expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toContain(practitioner);
    }
  });

  it('contains EIGHT ANCHOR EXAMPLES section covering the required vertical mix', () => {
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toMatch(/EIGHT ANCHOR EXAMPLES/);
    // Operator's greenlit vertical mix: MMO, biz-opp, weight loss,
    // nutra (distinct from weight loss), credit repair, ecom, SaaS,
    // info products. Regression pin — a future edit that drops a
    // vertical should surface here.
    for (const vertical of [
      'MMO',
      'Weight loss',
      'Nutra',
      'Credit repair',
      'Biz-opp',
      'Ecom',
      'SaaS',
      'Info product',
    ]) {
      expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toContain(vertical);
    }
  });

  it('anchor examples are dense with specifics ($ amounts, timeframes, named cities)', () => {
    // Every anchor example must earn its keep via specificity —
    // the whole point of the anchor block is to model
    // Georgi/Halbert-grade concreteness. Pin at least 12 dollar
    // signs across the anchors (the 8 examples routinely use 1-2
    // each between headline + body). If someone strips the
    // numbers the count drops and this fails.
    const dollarSignCount = (STATIC_WINNER_IMPORT_SYSTEM_PROMPT.match(/\$/g) ?? []).length;
    expect(dollarSignCount).toBeGreaterThanOrEqual(12);
  });

  it('anchor examples name specific cities to model "named individual + city + result" proof', () => {
    // Regression pin: at least 3 real US city names appear in the
    // anchors. City names are one of the strongest proof-anchors
    // per Georgi RMBC — dropping them silently weakens the model.
    const cityHits = ['Austin', 'Phoenix', 'Denver'].filter((c) =>
      STATIC_WINNER_IMPORT_SYSTEM_PROMPT.includes(c),
    );
    expect(cityHits.length).toBeGreaterThanOrEqual(3);
  });
});
