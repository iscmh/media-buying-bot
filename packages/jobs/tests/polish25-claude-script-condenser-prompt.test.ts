/**
 * Polish-25 Commit 2: Claude script condenser validator tests.
 *
 * Pins the operator-spec regression checks:
 *   - 1500-char cap
 *   - No nested quotes (mirrors Polish-23 Commit 3.0.23)
 *   - No appearance-word leakage
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

  it('containsPolish25AppearanceWords detects gender / ethnicity / age / hair / wardrobe', () => {
    expect(containsPolish25AppearanceWords('I am a male in my 60s')).toBe(true);
    expect(containsPolish25AppearanceWords('as a bald guy')).toBe(true);
    expect(containsPolish25AppearanceWords('white man wearing a suit')).toBe(true);
    expect(containsPolish25AppearanceWords('60-year-old dude')).toBe(true);
    expect(containsPolish25AppearanceWords('gray hair, salt-and-pepper')).toBe(true);
    expect(containsPolish25AppearanceWords('wearing a blue shirt')).toBe(true);
    // Action-only script (the GOOD shape)
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
      assertPolish25ScriptOk('60-year-old man speaks calmly to camera about savings.'),
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
    expect(p).toContain('appearance descriptions');
    expect(p).toContain('EMOTIONAL ARC');
    expect(p).toContain('NICHE');
  });

  it('composePolish25CondenserUserPrompt wraps the source analysis in <<<...>>> delimiters', () => {
    const user = composePolish25CondenserUserPrompt('{"persona":{"gender":"male"}}');
    expect(user).toContain('<<<');
    expect(user).toContain('>>>');
    expect(user).toContain('persona');
  });
});
