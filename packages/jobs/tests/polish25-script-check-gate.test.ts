/**
 * Polish-26.0.9 Commit 61.9: per-caller gate for the Polish-23-era
 * nested-quote validator on checkPolish25CondensedScript.
 *
 * Failure mode this defends against: Polish-23 Commit 3.0.23 added
 * containsQuotedThirdPartySpeech to defend Google Veo's TTS from
 * nested-quote patterns ("he said 'yes'"). HeyGen's TTS tolerates
 * nested quotes fine — real evidence: a fresh Polish-26 HeyGen
 * generation on concept ddca175b tripped this gate on the natural
 * "we'll see" pattern in the Claude-condensed script, blocking the
 * pipeline for no real reason.
 *
 * Fix: skipNestedQuotes option — Polish-26 workers pass true, all
 * other callers (Polish-25 MakeUGC) keep the check on by default.
 * All other checks (empty, too-long, appearance-leak) still fire
 * regardless of the flag.
 */
import { describe, expect, it } from 'vitest';
import { checkPolish25CondensedScript } from '../src/lib/polish25-claude-script-condenser-prompt';

// Straight-double-quote nested dialogue — matches
// POLISH23_NESTED_QUOTE_PATTERNS[0] (/"[^"]{3,}"/). Mirrors the
// operator's real concept-ddca175b failure family where Claude
// preserved dialogue verbatim in the condensed monologue.
const NESTED_QUOTE_SCRIPT =
  'I asked my daughter about it and she said "we\'ll see how it goes" and that stuck with me. ' +
  'Now I check the app every morning and it saves me hours.';

const CLEAN_SCRIPT =
  'I tried this app for two weeks and honestly the savings were real. ' +
  'I saved almost an hour a day just by tapping through the checklist.';

const APPEARANCE_LEAK_SCRIPT = "I'm a bald guy in my 60s and let me tell you what worked for me.";

describe('Polish-26.0.9: checkPolish25CondensedScript nested-quote gate', () => {
  it('DEFAULT (no options) still rejects nested-quote scripts (Polish-25 MakeUGC path)', () => {
    const result = checkPolish25CondensedScript(NESTED_QUOTE_SCRIPT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('nested-quotes');
    }
  });

  it('DEFAULT (explicit {}) still rejects nested-quote scripts', () => {
    const result = checkPolish25CondensedScript(NESTED_QUOTE_SCRIPT, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('nested-quotes');
    }
  });

  it('skipNestedQuotes:false STILL rejects nested-quote scripts (explicit opt-in)', () => {
    const result = checkPolish25CondensedScript(NESTED_QUOTE_SCRIPT, {
      skipNestedQuotes: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('nested-quotes');
    }
  });

  it('skipNestedQuotes:true ACCEPTS nested-quote scripts (Polish-26 HeyGen path)', () => {
    // This is the Commit 61.9 fix. HeyGen tolerates the pattern; the
    // Polish-26 worker passes {skipNestedQuotes:true} at the call site.
    const result = checkPolish25CondensedScript(NESTED_QUOTE_SCRIPT, {
      skipNestedQuotes: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chars).toBe(NESTED_QUOTE_SCRIPT.length);
    }
  });

  it('skipNestedQuotes:true still rejects EMPTY scripts', () => {
    const result = checkPolish25CondensedScript('', { skipNestedQuotes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('empty');
    }
  });

  it('skipNestedQuotes:true still rejects TOO-LONG scripts (>1500 chars)', () => {
    const tooLong = 'a'.repeat(1501);
    const result = checkPolish25CondensedScript(tooLong, { skipNestedQuotes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too-long');
    }
  });

  it('skipNestedQuotes:true still rejects APPEARANCE-LEAK scripts', () => {
    // The appearance-leak check protects the pre-cast-avatar invariant
    // regardless of vendor — every pre-cast pipeline visualizes
    // appearance so the script MUST NOT describe it.
    const result = checkPolish25CondensedScript(APPEARANCE_LEAK_SCRIPT, {
      skipNestedQuotes: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('appearance-leak');
    }
  });

  it('DEFAULT accepts clean scripts (baseline sanity)', () => {
    const result = checkPolish25CondensedScript(CLEAN_SCRIPT);
    expect(result.ok).toBe(true);
  });

  it('skipNestedQuotes:true accepts clean scripts (baseline sanity)', () => {
    const result = checkPolish25CondensedScript(CLEAN_SCRIPT, { skipNestedQuotes: true });
    expect(result.ok).toBe(true);
  });
});
