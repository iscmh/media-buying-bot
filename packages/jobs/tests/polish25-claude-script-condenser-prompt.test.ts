/**
 * Polish-25 Commit 2 + Commit 4: Claude script condenser validator
 * tests.
 *
 * Pins the operator-spec regression checks:
 *   - 1500-char cap
 *   - No nested quotes (mirrors Polish-23 Commit 3.0.23)
 *   - Context-aware self-referential appearance detection
 *     (Commit 4 — was word-only in Commit 2 and false-positived
 *     on natural third-person dialogue; see job 6ccf05d7)
 *   - Zod schema round-trip
 */
import { describe, expect, it } from 'vitest';
import {
  POLISH25_APPEARANCE_WORD_PATTERNS,
  POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT,
  POLISH25_CONDENSED_SCRIPT_MAX_CHARS,
  Polish25CondensedScriptSchema,
  assertPolish25ScriptOk,
  checkPolish25CondensedScript,
  composePolish25CondenserUserPrompt,
  containsPolish25AppearanceWords,
} from '../src/lib/polish25-claude-script-condenser-prompt';

describe('Polish-25 Commit 2: condensed-script constants + validators', () => {
  it('POLISH25_CONDENSED_SCRIPT_MAX_CHARS = 1500 (matches MakeUGC voice_script cap)', () => {
    expect(POLISH25_CONDENSED_SCRIPT_MAX_CHARS).toBe(1500);
  });

  it('containsPolish25AppearanceWords flags SELF-REFERENTIAL appearance descriptions', () => {
    // Direct first-person self-description (all flag)
    expect(containsPolish25AppearanceWords('I am a male in my 60s')).toBe(true);
    expect(containsPolish25AppearanceWords('as a bald guy, I know things')).toBe(true);
    expect(containsPolish25AppearanceWords('I have gray hair')).toBe(true);
    expect(containsPolish25AppearanceWords("I'm 64 years old")).toBe(true);
    expect(containsPolish25AppearanceWords("I'm bald")).toBe(true);
    expect(containsPolish25AppearanceWords("I'm wearing a suit")).toBe(true);
    expect(containsPolish25AppearanceWords('as a white man, I get it')).toBe(true);
    expect(containsPolish25AppearanceWords('at my age you learn things')).toBe(true);
  });

  it('containsPolish25AppearanceWords does NOT flag natural third-person dialogue', () => {
    // Action-only script (still the GOOD shape)
    expect(
      containsPolish25AppearanceWords(
        'I tried this app for two weeks and honestly the savings were real.',
      ),
    ).toBe(false);
    expect(containsPolish25AppearanceWords('speaks calmly to camera')).toBe(false);
  });

  it('exports the appearance pattern list for external inspection', () => {
    expect(POLISH25_APPEARANCE_WORD_PATTERNS.length).toBeGreaterThan(5);
  });

  it('checkPolish25CondensedScript returns typed reasons per failure mode', () => {
    // empty
    expect(checkPolish25CondensedScript('').ok).toBe(false);
    expect(checkPolish25CondensedScript('   ').ok).toBe(false);
    // too-long
    const long = 'x'.repeat(1501);
    const longRes = checkPolish25CondensedScript(long);
    expect(longRes.ok).toBe(false);
    if (!longRes.ok) expect(longRes.reason).toBe('too-long');
    // nested-quotes (mirror Polish-23 Commit 3.0.23 anchor)
    const nestedQuoteScript =
      "So I hit up my buddy Frank. He said, 'David, just enjoy retirement, that's what matters.'";
    const nestedRes = checkPolish25CondensedScript(nestedQuoteScript);
    expect(nestedRes.ok).toBe(false);
    if (!nestedRes.ok) expect(nestedRes.reason).toBe('nested-quotes');
    // appearance-leak
    const appearanceScript = 'As a 60-year-old man, I want to tell you about this app.';
    const appearanceRes = checkPolish25CondensedScript(appearanceScript);
    expect(appearanceRes.ok).toBe(false);
    if (!appearanceRes.ok) expect(appearanceRes.reason).toBe('appearance-leak');
    // happy path
    const good =
      'I tried this app for two weeks and honestly the savings were real. ' +
      'I got the notification, tapped it, and there was money back. Straightforward.';
    const goodRes = checkPolish25CondensedScript(good);
    expect(goodRes.ok).toBe(true);
    if (goodRes.ok) expect(goodRes.chars).toBe(good.length);
  });

  it('assertPolish25ScriptOk throws on any violation, no-ops on happy path', () => {
    expect(() =>
      assertPolish25ScriptOk('As a 60-year-old man, I speak calmly to camera about savings.'),
    ).toThrow(/appearance-leak|too-long|nested-quotes/);
    expect(() =>
      assertPolish25ScriptOk('I tried this app for two weeks and honestly the savings were real.'),
    ).not.toThrow();
  });

  it('Polish25CondensedScriptSchema Zod refine round-trips happy + rejects violations', () => {
    const good =
      'I tried this app for two weeks and honestly the savings were real. ' +
      'I got the notification, tapped it, and there was money back.';
    expect(Polish25CondensedScriptSchema.safeParse(good).success).toBe(true);
    expect(
      Polish25CondensedScriptSchema.safeParse('As a 60-year-old man, I want to tell you.').success,
    ).toBe(false);
    expect(Polish25CondensedScriptSchema.safeParse('x'.repeat(1501)).success).toBe(false);
    expect(Polish25CondensedScriptSchema.safeParse('').success).toBe(false);
  });

  it('system prompt pins the HARD CONSTRAINT anchors (5 numbered rules)', () => {
    const p = POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT;
    expect(p).toContain('MAXIMUM 1500 characters');
    expect(p).toContain('FIRST-PERSON monologue only');
    expect(p).toContain('nested quotes');
    // Commit 4: prompt language shifted from "appearance descriptions"
    // → "SELF-APPEARANCE descriptions" (third-person dialogue is fine).
    expect(p).toContain('SELF-APPEARANCE descriptions');
    expect(p).toContain('EMOTIONAL ARC');
    expect(p).toContain('NICHE');
  });

  it('Commit 4: system prompt explicitly allows third-person dialogue about others', () => {
    const p = POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT;
    expect(p).toContain('granddaughter');
    expect(p).toContain('third-person');
  });

  it('composePolish25CondenserUserPrompt wraps the source analysis in <<<...>>> delimiters', () => {
    const user = composePolish25CondenserUserPrompt('{"persona":{"gender":"male"}}');
    expect(user).toContain('<<<');
    expect(user).toContain('>>>');
    expect(user).toContain('persona');
  });
});

describe('Polish-25 Commit 4: context-aware self-referential appearance detection', () => {
  // ------------ MUST NOT FLAG (natural third-person dialogue) ------------
  it('does NOT flag "She\'s seven" (third-person, other character)', () => {
    expect(containsPolish25AppearanceWords("She's seven.")).toBe(false);
  });

  it('does NOT flag "my granddaughter" (relationship, not appearance)', () => {
    expect(
      containsPolish25AppearanceWords('My granddaughter asked me if we could go to Disney World.'),
    ).toBe(false);
    expect(containsPolish25AppearanceWords('my granddaughter')).toBe(false);
    expect(containsPolish25AppearanceWords('my daughter, my son, my wife')).toBe(false);
    expect(containsPolish25AppearanceWords('my friend went')).toBe(false);
  });

  it('does NOT flag the exact job 6ccf05d7 grandfather-perspective excerpt', () => {
    const script =
      "My granddaughter asked me if we could go to Disney World. She's seven. " +
      "She doesn't know what things cost. She just knows her friend went. " +
      "I told her we'd see. And she's starting to figure out what that really means. " +
      "I'm on a pension, so every dollar counts.";
    expect(containsPolish25AppearanceWords(script)).toBe(false);
    // Full-pipeline check: script must pass the whole validator.
    expect(checkPolish25CondensedScript(script).ok).toBe(true);
  });

  it('does NOT flag third-person pronouns describing others', () => {
    expect(containsPolish25AppearanceWords('He told me it would be fine.')).toBe(false);
    expect(containsPolish25AppearanceWords('She just knows her friend went.')).toBe(false);
    expect(containsPolish25AppearanceWords('They said the same thing to me.')).toBe(false);
    expect(containsPolish25AppearanceWords('His advice made sense at the time.')).toBe(false);
  });

  it('does NOT flag ambiguous bare appearance strings without first-person context', () => {
    // These flipped from Commit-2-flagged to Commit-4-allowed by design.
    // Rationale: without a first-person cue, we can't distinguish a
    // self-reference from third-person narration ("she was wearing a
    // blue shirt"). Operator-approved: err toward NOT flagging so
    // natural dialogue survives.
    expect(containsPolish25AppearanceWords('white man wearing a suit')).toBe(false);
    expect(containsPolish25AppearanceWords('60-year-old dude walked in')).toBe(false);
    expect(containsPolish25AppearanceWords('gray hair, salt-and-pepper')).toBe(false);
    expect(containsPolish25AppearanceWords('wearing a blue shirt')).toBe(false);
  });

  // ------------ MUST FLAG (self-referential appearance) ------------
  it('flags "I have gray hair" (self-hair)', () => {
    expect(containsPolish25AppearanceWords('I have gray hair')).toBe(true);
    expect(containsPolish25AppearanceWords("I've got gray hair now.")).toBe(true);
    expect(containsPolish25AppearanceWords('my gray hair')).toBe(true);
    expect(containsPolish25AppearanceWords('my salt-and-pepper hair says it all')).toBe(true);
  });

  it('flags "I\'m 64 years old" (self-age)', () => {
    expect(containsPolish25AppearanceWords("I'm 64 years old")).toBe(true);
    expect(containsPolish25AppearanceWords('I am 64')).toBe(true);
    expect(containsPolish25AppearanceWords("I'm a 60-year-old")).toBe(true);
    expect(containsPolish25AppearanceWords("I'm in my 60s")).toBe(true);
    expect(containsPolish25AppearanceWords('in my late 60s')).toBe(true);
    expect(containsPolish25AppearanceWords('at my age you learn a few things')).toBe(true);
    expect(containsPolish25AppearanceWords('aged 64')).toBe(true);
  });

  it('flags "as a white man" (self-declared ethnicity)', () => {
    expect(containsPolish25AppearanceWords('as a white man, I get it')).toBe(true);
    expect(containsPolish25AppearanceWords("I'm white")).toBe(true);
    expect(containsPolish25AppearanceWords("I'm a hispanic guy")).toBe(true);
    expect(containsPolish25AppearanceWords("as a black woman, I've seen this")).toBe(true);
  });

  it('flags self-declared gender', () => {
    expect(containsPolish25AppearanceWords("I'm a man")).toBe(true);
    expect(containsPolish25AppearanceWords('I am a woman')).toBe(true);
    expect(containsPolish25AppearanceWords("I'm a lady")).toBe(true);
    expect(containsPolish25AppearanceWords('as a bald guy, I know')).toBe(true);
  });

  it('flags self-wardrobe descriptions', () => {
    expect(containsPolish25AppearanceWords("I'm wearing my favorite blue sweater")).toBe(true);
    expect(containsPolish25AppearanceWords("I'm dressed in a black suit")).toBe(true);
    expect(containsPolish25AppearanceWords('my favorite hoodie')).toBe(true);
    expect(containsPolish25AppearanceWords('wearing my old jacket')).toBe(true);
  });

  it('flags "I\'m bald" (self-hair loss)', () => {
    expect(containsPolish25AppearanceWords("I'm bald")).toBe(true);
    expect(containsPolish25AppearanceWords('I am balding')).toBe(true);
  });
});
