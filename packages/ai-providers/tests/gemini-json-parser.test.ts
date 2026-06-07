/**
 * Polish-9.11: Gemini JSON response parser hardening. The vision API
 * ignores response_mime_type ~1 in 10 calls and returns fenced /
 * preamble-wrapped / trailing-prose responses. The robust extractor
 * peels back the layers and surfaces a diagnostic excerpt on hard
 * failure instead of a generic "not valid JSON".
 */
import { describe, expect, it } from 'vitest';
import { tryParseGeminiJson } from '../src/gemini-client';

describe('Polish-9.11: tryParseGeminiJson', () => {
  it('pure JSON object → parses cleanly', () => {
    const r = tryParseGeminiJson('{"foo": 1, "bar": "two"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ foo: 1, bar: 'two' });
  });

  it('pure JSON array → parses cleanly', () => {
    const r = tryParseGeminiJson('[1, 2, 3]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([1, 2, 3]);
  });

  it('JSON wrapped in ```json fences → parses cleanly', () => {
    const r = tryParseGeminiJson('```json\n{"hook": "ok"}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ hook: 'ok' });
  });

  it('JSON wrapped in bare ``` fences → parses cleanly', () => {
    const r = tryParseGeminiJson('```\n{"hook": "ok"}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ hook: 'ok' });
  });

  it('JSON with preamble "Here is the analysis: {...}" → parses cleanly', () => {
    const r = tryParseGeminiJson('Here is the analysis:\n{"score": 7, "label": "great"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ score: 7, label: 'great' });
  });

  it('JSON with trailing prose "{...} hope this helps" → parses cleanly', () => {
    const r = tryParseGeminiJson(
      '{"score": 8, "notes": "good"}\n\nLet me know if you need more details.',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ score: 8, notes: 'good' });
  });

  it('JSON with both preamble AND trailing prose → parses cleanly', () => {
    const r = tryParseGeminiJson('Sure! Here is the result:\n{"a": 1}\n\nThanks!');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1 });
  });

  it('fenced JSON with preamble outside the fence → parses cleanly via brace fallback', () => {
    const r = tryParseGeminiJson(
      'Here you go:\n```json\n{"foo": "bar"}\n```\nLet me know if you need anything else.',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ foo: 'bar' });
  });

  it('array root with preamble → parses cleanly via bracket fallback', () => {
    const r = tryParseGeminiJson('Here are the items:\n[1, 2, 3]\n\nDone.');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([1, 2, 3]);
  });

  it('pure prose with no JSON → returns error with first-500-chars diagnostic', () => {
    const r = tryParseGeminiJson(
      "I can't analyze that video because it contains restricted content. Sorry about that.",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not parseable as JSON/i);
      expect(r.error).toMatch(/First 500 chars/);
      expect(r.error).toContain("I can't analyze that video");
    }
  });

  it('malformed truncated JSON → returns error with diagnostic preview', () => {
    const broken = '{"foo": 1, "bar": "tw' + 'a'.repeat(800);
    const r = tryParseGeminiJson(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not parseable as JSON/i);
      expect(r.error).toMatch(/First 500 chars/);
      // Diagnostic preview is capped at 500 chars.
      expect(r.error.length).toBeLessThan(700);
    }
  });

  it('empty string → returns error', () => {
    const r = tryParseGeminiJson('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not parseable as JSON/i);
  });
});
