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

  it('bans corporate hedging phrases by name', () => {
    // Regression pin: the exact hedging vocabulary. A future edit
    // that removes any of these from the banlist should surface
    // in code review, not silently soften the guard.
    for (const word of [
      'leverage',
      'unlock',
      'empower',
      'revolutionize',
      'cutting-edge',
      'game-changing',
      'unleash',
      'elevate',
      'seamless',
    ]) {
      expect(SHARED_ANTI_AI_VOICE_RULES).toContain(word);
    }
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
