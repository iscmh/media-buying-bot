/**
 * Polish-23 Commit 3: end-to-end worker tests.
 *
 * Pins:
 *   - Claude ad-spec parser tolerates markdown fences / prose
 *     preamble / bare JSON. Falls back to Linda anchor on any
 *     validation failure.
 *   - Fallback ad-spec is Linda + 8 segments, every dialogue 20-24 words.
 *   - Progress percentages match operator spec anchors: 5 / 15 / 25 /
 *     25+i/8×60 (clamped [25,85]) / 95 / 100.
 *   - AdSpecSchema requires exactly 8 segments (not 7, not 9).
 *   - extractSourceScript reads metadata.analysis.script_transcription
 *     defensively.
 *   - Worker registration: generatePolish23VeoLite is in functions[] AND
 *     the reserved event is in REGISTERED_GENERATION_WORKER_EVENTS.
 *   - loadDecryptedKeys typing supports 'wavespeed_ai' (adding it in
 *     Commit 3 was required for the Higgsfield Soul step to compile).
 */
import { describe, expect, it } from 'vitest';
import { REGISTERED_GENERATION_WORKER_EVENTS, functions } from '../src/functions';
import { generatePolish23VeoLite } from '../src/functions/generate-polish23-veo-lite';
import {
  AdSpecSchema,
  POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT,
  POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT,
  POLISH23_CLIP_SECONDS,
  POLISH23_NESTED_QUOTE_PATTERNS,
  POLISH23_SEGMENT_COUNT,
  SegmentSpecSchema,
  assertAllSegmentsValid,
  coalesceAdSpecWithFallback,
  composePolish23AdSpecUserPrompt,
  containsQuotedThirdPartySpeech,
  diagnosePolish23AdSpecParseFailure,
  fallbackPolish23AdSpec,
  getPolish23AdSpecSystemPrompt,
  isValidSegment,
  parsePolish23AdSpec,
} from '../src/lib/polish23-claude-adspec-prompt';
import {
  POLISH23_PROMPT_MAX_CHARS,
  computePolish23Progress,
  computePolish23SegmentProgress,
  extractSourceScript,
  softTruncatePromptForVeo,
} from '../src/functions/generate-polish23-veo-lite';
import { checkDialogueWordCount } from '@mbb/ai-providers';
import { FALLBACK_CHARACTER_LOCK } from '@mbb/shared';

describe('Polish-23 Commit 3: constants + operator anchors', () => {
  it('exactly 8 segments per batch (BCH 60s = 8×8s anchor)', () => {
    expect(POLISH23_SEGMENT_COUNT).toBe(8);
    expect(POLISH23_CLIP_SECONDS).toBe(8);
  });
});

describe('Polish-23 Commit 3: parsePolish23AdSpec — Claude output tolerance', () => {
  function validAdSpecJson(): string {
    const spec = fallbackPolish23AdSpec();
    return JSON.stringify(spec);
  }

  it('parses clean JSON', () => {
    const r = parsePolish23AdSpec(validAdSpecJson());
    expect(r).not.toBeNull();
    expect(r!.segments).toHaveLength(8);
  });

  it('strips leading prose ("Here is the JSON:")', () => {
    const r = parsePolish23AdSpec('Here is the JSON:\n\n' + validAdSpecJson());
    expect(r).not.toBeNull();
  });

  it('strips markdown ```json fences', () => {
    const r = parsePolish23AdSpec('```json\n' + validAdSpecJson() + '\n```');
    expect(r).not.toBeNull();
  });

  it('strips markdown ``` (no lang) fences', () => {
    const r = parsePolish23AdSpec('```\n' + validAdSpecJson() + '\n```');
    expect(r).not.toBeNull();
  });

  it('returns null on non-JSON', () => {
    expect(parsePolish23AdSpec('nothing useful here')).toBeNull();
    expect(parsePolish23AdSpec('')).toBeNull();
    expect(parsePolish23AdSpec(null)).toBeNull();
    expect(parsePolish23AdSpec(undefined)).toBeNull();
  });

  it('returns null when JSON parses but fails schema (wrong segment count)', () => {
    const spec = fallbackPolish23AdSpec();
    // Only 7 segments — schema requires 8 exactly.
    const bad = { ...spec, segments: spec.segments.slice(0, 7) };
    expect(parsePolish23AdSpec(JSON.stringify(bad))).toBeNull();
  });

  it('returns null when JSON parses but character_lock is missing fields', () => {
    const spec = fallbackPolish23AdSpec();
    const bad = {
      ...spec,
      character_lock: { name: 'X' }, // missing everything else
    };
    expect(parsePolish23AdSpec(JSON.stringify(bad))).toBeNull();
  });
});

describe('Polish-23 Commit 3: fallbackPolish23AdSpec — Linda anchor + 20-24 word dialogues', () => {
  it('is a valid AdSpec that survives round-trip through the schema', () => {
    const spec = fallbackPolish23AdSpec();
    const round = AdSpecSchema.safeParse(JSON.parse(JSON.stringify(spec)));
    expect(round.success).toBe(true);
  });

  it('uses the Linda character (matches FALLBACK_CHARACTER_LOCK)', () => {
    const spec = fallbackPolish23AdSpec();
    expect(spec.character_lock.name).toBe(FALLBACK_CHARACTER_LOCK.name);
    expect(spec.character_lock.age).toBe(FALLBACK_CHARACTER_LOCK.age);
    expect(spec.character_lock.gender).toBe(FALLBACK_CHARACTER_LOCK.gender);
  });

  it('every segment dialogue is 20-24 words (survives checkDialogueWordCount)', () => {
    const spec = fallbackPolish23AdSpec();
    for (const [i, seg] of spec.segments.entries()) {
      const check = checkDialogueWordCount(seg.dialogue);
      expect({ i, ok: check.ok, wc: check.wordCount }).toEqual({
        i,
        ok: true,
        wc: check.wordCount,
      });
    }
  });

  it('every segment has non-empty sceneDirection', () => {
    const spec = fallbackPolish23AdSpec();
    for (const seg of spec.segments) {
      expect(seg.sceneDirection.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('Polish-23 Commit 3: computePolish23Progress — operator anchors', () => {
  it('5 / 15 / 25 / 95 / 100 milestone anchors', () => {
    expect(computePolish23Progress('analyze-concept')).toBe(5);
    expect(computePolish23Progress('claude-ad-spec')).toBe(15);
    expect(computePolish23Progress('higgsfield-soul')).toBe(25);
    expect(computePolish23Progress('concat')).toBe(95);
    expect(computePolish23Progress('upload')).toBe(100);
    expect(computePolish23Progress('complete')).toBe(100);
  });
});

describe('Polish-23 Commit 3: computePolish23SegmentProgress — 25 + (i+1)/N × 60, clamped [25,85]', () => {
  it('clip 0 of 8 → ~33 (25 + 1/8 × 60 = 32.5 → 33)', () => {
    expect(computePolish23SegmentProgress(0, 8)).toBe(33);
  });

  it('clip 3 of 8 → ~55 (25 + 4/8 × 60 = 55)', () => {
    expect(computePolish23SegmentProgress(3, 8)).toBe(55);
  });

  it('clip 7 of 8 → ~85 (25 + 8/8 × 60 = 85)', () => {
    expect(computePolish23SegmentProgress(7, 8)).toBe(85);
  });

  it('never below 25 or above 85 (guards against bad segment counts)', () => {
    expect(computePolish23SegmentProgress(-1, 8)).toBeGreaterThanOrEqual(25);
    expect(computePolish23SegmentProgress(100, 8)).toBeLessThanOrEqual(85);
    expect(computePolish23SegmentProgress(0, 0)).toBeGreaterThanOrEqual(25);
  });
});

describe('Polish-23 Commit 3: extractSourceScript — defensive metadata read', () => {
  it('reads metadata.analysis.script_transcription', () => {
    expect(
      extractSourceScript({
        analysis: { script_transcription: 'I swear to god this drugstore toner is INSANE' },
      }),
    ).toBe('I swear to god this drugstore toner is INSANE');
  });

  it('returns empty string when analysis missing', () => {
    expect(extractSourceScript({})).toBe('');
    expect(extractSourceScript(null)).toBe('');
    expect(extractSourceScript({ other: 'stuff' })).toBe('');
  });

  it('returns empty string when analysis.script_transcription is non-string', () => {
    expect(extractSourceScript({ analysis: { script_transcription: 42 } })).toBe('');
    expect(extractSourceScript({ analysis: { script_transcription: null } })).toBe('');
  });

  it('returns empty string when analysis is not an object (defensive)', () => {
    expect(extractSourceScript({ analysis: 'not-an-object' })).toBe('');
  });
});

describe('Polish-23 Commit 3: composePolish23AdSpecUserPrompt — carries the source verbatim', () => {
  it('embeds the source script inside triple-bracket delimiters', () => {
    const p = composePolish23AdSpecUserPrompt('Julia probiotic pitch here');
    expect(p).toMatch(/<<<\nJulia probiotic pitch here\n>>>/);
    expect(p).toMatch(/Emit the JSON object per the schema above\./);
  });
});

describe('Polish-23 Commit 3: worker registration — the miss-once-caught tripwire', () => {
  it("registers 'generation/polish23-veo-lite.requested' in REGISTERED_GENERATION_WORKER_EVENTS (Commit 1 reservation)", () => {
    expect(REGISTERED_GENERATION_WORKER_EVENTS.has('generation/polish23-veo-lite.requested')).toBe(
      true,
    );
  });

  it('adds the worker function to functions[] (dispatch coverage)', () => {
    // Identity check by reference — avoids Inngest SDK's private
    // `id` getter shape drift across versions.
    expect(functions).toContain(generatePolish23VeoLite);
  });
});

describe('Polish-23 Commit 3.0.1: diagnosePolish23AdSpecParseFailure — names WHY parsing failed', () => {
  function validJson(): string {
    return JSON.stringify(fallbackPolish23AdSpec());
  }

  it("empty / null / undefined → reason='empty'", () => {
    for (const bad of ['', null, undefined]) {
      const r = diagnosePolish23AdSpecParseFailure(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('empty');
    }
  });

  it("prose with no braces → reason='no-json-braces'", () => {
    const r = diagnosePolish23AdSpecParseFailure('I am not going to write JSON for you.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-json-braces');
  });

  it("malformed JSON inside braces → reason='json-parse-error' + detail carries the parser message", () => {
    const r = diagnosePolish23AdSpecParseFailure('{ "character_lock": { ,,, invalid ,,, } }');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('json-parse-error');
      expect(r.detail).toBeDefined();
      expect(r.detail!.length).toBeGreaterThan(0);
    }
  });

  it("Claude returns valid JSON but wrong segment count → reason='schema-mismatch' + detail names the field", () => {
    const spec = fallbackPolish23AdSpec();
    const bad = { ...spec, segments: spec.segments.slice(0, 6) };
    const r = diagnosePolish23AdSpecParseFailure(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('schema-mismatch');
      expect(r.detail).toMatch(/segments/i);
    }
  });

  it("Claude returns valid JSON but character_lock missing fields → reason='schema-mismatch' + detail names the field", () => {
    const spec = fallbackPolish23AdSpec();
    const bad = { ...spec, character_lock: { name: 'X' } };
    const r = diagnosePolish23AdSpecParseFailure(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('schema-mismatch');
      expect(r.detail).toMatch(/character_lock/);
    }
  });

  it('success → ok:true carries the parsed AdSpec (character_lock + segments both populated)', () => {
    const r = diagnosePolish23AdSpecParseFailure(validJson());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.character_lock.name).toBeTruthy();
      expect(r.data.segments).toHaveLength(POLISH23_SEGMENT_COUNT);
    }
  });

  it('parsePolish23AdSpec remains a { AdSpec | null } shim over the diagnose helper (existing callers keep working)', () => {
    // Regression pin — anyone importing parsePolish23AdSpec still
    // gets the pre-Commit-3.0.1 signature.
    expect(parsePolish23AdSpec(validJson())).not.toBeNull();
    expect(parsePolish23AdSpec('nope')).toBeNull();
  });
});

describe('Polish-23 Commit 3.0.1: assertAllSegmentsValid — pre-Step-C invariant guard', () => {
  it('passes on a full 8-segment fallback ad-spec', () => {
    expect(() => assertAllSegmentsValid(fallbackPolish23AdSpec().segments)).not.toThrow();
  });

  it('throws on non-array (drift signal — schema was loosened somewhere)', () => {
    expect(() => assertAllSegmentsValid('not-an-array' as never)).toThrow(/not an array/);
    expect(() => assertAllSegmentsValid(null as never)).toThrow(/not an array/);
  });

  it('throws on wrong length + names the actual length in the message', () => {
    const short = fallbackPolish23AdSpec().segments.slice(0, 5);
    expect(() => assertAllSegmentsValid(short)).toThrow(/length 5 !== 8/);
  });

  it('throws on undefined / null entry + names the offending index (would have caught the Commit 3 first-live failure)', () => {
    const spec = fallbackPolish23AdSpec();
    const badUndef = [...spec.segments];
    badUndef[0] = undefined as never;
    expect(() => assertAllSegmentsValid(badUndef)).toThrow(/segments\[0\] is undefined/);

    const badNull = [...spec.segments];
    badNull[3] = null as never;
    expect(() => assertAllSegmentsValid(badNull)).toThrow(/segments\[3\] is null/);
  });

  it('throws on empty dialogue string + names the field', () => {
    const spec = fallbackPolish23AdSpec();
    const bad = [...spec.segments];
    bad[2] = { ...bad[2]!, dialogue: '   ' };
    expect(() => assertAllSegmentsValid(bad)).toThrow(/segments\[2\]\.dialogue is empty/);
  });

  it('throws on empty sceneDirection + names the field', () => {
    const spec = fallbackPolish23AdSpec();
    const bad = [...spec.segments];
    bad[5] = { ...bad[5]!, sceneDirection: '' };
    expect(() => assertAllSegmentsValid(bad)).toThrow(/segments\[5\]\.sceneDirection is empty/);
  });
});

describe('Polish-23 Commit 3.0.2: isValidSegment — segment validity primitive', () => {
  it('accepts a fully-formed segment', () => {
    expect(isValidSegment({ dialogue: 'hi there friend', sceneDirection: 'Linda waves' })).toBe(
      true,
    );
  });

  it('rejects null / undefined', () => {
    expect(isValidSegment(null)).toBe(false);
    expect(isValidSegment(undefined)).toBe(false);
  });

  it('rejects empty / whitespace-only dialogue', () => {
    expect(isValidSegment({ dialogue: '', sceneDirection: 'x' })).toBe(false);
    expect(isValidSegment({ dialogue: '   ', sceneDirection: 'x' })).toBe(false);
  });

  it('rejects empty / whitespace-only sceneDirection', () => {
    expect(isValidSegment({ dialogue: 'x', sceneDirection: '' })).toBe(false);
    expect(isValidSegment({ dialogue: 'x', sceneDirection: '   ' })).toBe(false);
  });

  it('rejects non-string fields (drift signal)', () => {
    expect(isValidSegment({ dialogue: 42 as unknown as string, sceneDirection: 'x' })).toBe(false);
  });
});

describe('Polish-23 Commit 3.0.2: coalesceAdSpecWithFallback — safety-net contract', () => {
  it('parsed=null → wholesale fallback, no per-segment tracking', () => {
    const r = coalesceAdSpecWithFallback(null);
    expect(r.wholesaleFallback).toBe(true);
    expect(r.segmentFallbackIndices).toEqual([]);
    expect(r.adSpec.character_lock.name).toBe('Linda');
    expect(r.adSpec.segments).toHaveLength(8);
  });

  it('parsed=valid → identity return, no fallback tracking', () => {
    const parsed = fallbackPolish23AdSpec();
    // Change character name so we can prove the parsed shape wins.
    const custom = { ...parsed, character_lock: { ...parsed.character_lock, name: 'Marcos' } };
    const r = coalesceAdSpecWithFallback(custom);
    expect(r.wholesaleFallback).toBe(false);
    expect(r.segmentFallbackIndices).toEqual([]);
    expect(r.adSpec.character_lock.name).toBe('Marcos');
    // Segments preserved verbatim.
    expect(r.adSpec.segments).toEqual(custom.segments);
  });

  it('parsed with SOME invalid segments → per-index backfill from fallback, indices tracked', () => {
    const parsed = fallbackPolish23AdSpec();
    const fallback = fallbackPolish23AdSpec();
    // Corrupt segments 2 and 5.
    const corrupted = {
      ...parsed,
      segments: parsed.segments.map((s, i) =>
        i === 2 ? { ...s, dialogue: '' } : i === 5 ? { ...s, sceneDirection: '   ' } : s,
      ),
    };
    const r = coalesceAdSpecWithFallback(corrupted, fallback);
    expect(r.wholesaleFallback).toBe(false);
    expect(r.segmentFallbackIndices).toEqual([2, 5]);
    // Slots 2 and 5 now match the fallback verbatim.
    expect(r.adSpec.segments[2]).toEqual(fallback.segments[2]);
    expect(r.adSpec.segments[5]).toEqual(fallback.segments[5]);
    // Other slots preserved from parsed input.
    expect(r.adSpec.segments[0]).toEqual(parsed.segments[0]);
    expect(r.adSpec.segments[7]).toEqual(parsed.segments[7]);
  });

  it('parsed with undefined segment slot → per-index backfill (defensive against sparse arrays)', () => {
    const parsed = fallbackPolish23AdSpec();
    const sparse = { ...parsed, segments: [...parsed.segments] };
    (sparse.segments as unknown as (unknown | undefined)[])[4] = undefined;
    const r = coalesceAdSpecWithFallback(sparse as never);
    expect(r.segmentFallbackIndices).toEqual([4]);
    expect(r.adSpec.segments[4]).toEqual(fallbackPolish23AdSpec().segments[4]);
  });

  it('character_lock always comes from parsed input when present (never overwritten by fallback)', () => {
    const parsed = fallbackPolish23AdSpec();
    const custom = {
      ...parsed,
      character_lock: { ...parsed.character_lock, name: 'Julia', age: 32 },
    };
    // Even with all segments needing fallback, character_lock stays parsed.
    const allBad = {
      ...custom,
      segments: custom.segments.map((s) => ({ ...s, dialogue: '' })),
    };
    const r = coalesceAdSpecWithFallback(allBad);
    expect(r.adSpec.character_lock.name).toBe('Julia');
    expect(r.adSpec.character_lock.age).toBe(32);
    expect(r.segmentFallbackIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('output segments are always length 8 exactly (post-coalesce invariant)', () => {
    for (const parsed of [
      null,
      fallbackPolish23AdSpec(),
      { ...fallbackPolish23AdSpec(), segments: [] as never },
    ]) {
      const r = coalesceAdSpecWithFallback(parsed);
      expect(r.adSpec.segments).toHaveLength(8);
    }
  });
});

describe('Polish-23 Commit 3.0.8: softTruncatePromptForVeo — length ceiling + graceful marker', () => {
  it('constant anchor: POLISH23_PROMPT_MAX_CHARS = 3500 (raised from 3000 in Commit 3.0.30 to fit SETTING INVARIANT block)', () => {
    expect(POLISH23_PROMPT_MAX_CHARS).toBe(3500);
  });

  it('passes short prompts through untouched (truncated=false, originalChars matches)', () => {
    const r = softTruncatePromptForVeo('hello world');
    expect(r.truncated).toBe(false);
    expect(r.prompt).toBe('hello world');
    expect(r.originalChars).toBe(11);
  });

  it('respects the boundary — a prompt exactly at maxChars is NOT truncated', () => {
    const s = 'a'.repeat(3500);
    const r = softTruncatePromptForVeo(s);
    expect(r.truncated).toBe(false);
    expect(r.prompt.length).toBe(3500);
  });

  it('truncates over-length prompts with a visible marker, preserving as much prefix as possible', () => {
    const s = 'X'.repeat(5000);
    const r = softTruncatePromptForVeo(s);
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBe(5000);
    // Total (prefix + marker) never exceeds maxChars.
    expect(r.prompt.length).toBeLessThanOrEqual(POLISH23_PROMPT_MAX_CHARS);
    // Marker is visible + names the original length.
    expect(r.prompt).toMatch(/truncated at 3500 chars/);
    expect(r.prompt).toMatch(/original was 5000/);
    // Prefix preserved verbatim.
    expect(r.prompt.startsWith('X'.repeat(100))).toBe(true);
  });

  it('respects an explicit maxChars override for future-proofing', () => {
    const r = softTruncatePromptForVeo('a'.repeat(500), 100);
    expect(r.truncated).toBe(true);
    expect(r.prompt.length).toBeLessThanOrEqual(100);
    expect(r.originalChars).toBe(500);
  });
});

describe('Polish-23 Commit 3.0.6: markJobCompleted never touches metadata (Step-E ordering pin)', () => {
  it('inspects packages/jobs/src/lib/job-markers.ts source and confirms markJobCompleted only updates status / completedAt / generatedCreativeCount / actualCostUsd', async () => {
    // Regression pin: the Polish-23 worker's Step E writes composed
    // prompts, submit bodies, and composite URL to metadata; then
    // calls markJobCompleted to flip status. This test proves the
    // ordering is safe (metadata-write BEFORE markJobCompleted is
    // NOT required, because markJobCompleted doesn't spread over
    // metadata). If a future refactor makes markJobCompleted touch
    // metadata, this pin fails loud so the Polish-23 worker gets
    // updated to defensively order writes.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('../src/lib/job-markers.ts', import.meta.url), 'utf8');
    // Extract the markJobCompleted function body.
    const marker = 'export async function markJobCompleted(';
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    // Walk to the matching closing brace at the outer function.
    const funcEnd = src.indexOf('\n}\n', start);
    expect(funcEnd).toBeGreaterThan(start);
    const body = src.slice(start, funcEnd);
    // Contract: NO reference to `metadata:` inside the .set() call.
    // A false positive here is fine — we WANT this to fail if
    // markJobCompleted grows a metadata write, so the worker can
    // be updated accordingly.
    expect(body).not.toMatch(/\bmetadata:/);
    // Confirm the expected fields ARE touched.
    expect(body).toMatch(/status:\s*'completed'/);
    expect(body).toMatch(/completedAt:/);
    expect(body).toMatch(/generatedCreativeCount:/);
    expect(body).toMatch(/actualCostUsd:/);
  });
});

describe('Polish-23 Commit 3.0.2: fallback pairs character_lock + segments (regression pin — was 3.0.1)', () => {
  it('fallbackPolish23AdSpec always returns BOTH fields — worker cannot land segments=undefined', () => {
    // Commit 3.0.1 diagnosis note: the operator's first-live report
    // suggested character_lock was set but segments was undefined.
    // This pin proves the fallback shape can't produce that state —
    // if the runtime observed it, the drift happened AFTER Step A
    // return, which the assertAllSegmentsValid guard now catches.
    const spec = fallbackPolish23AdSpec();
    expect(spec.character_lock).toBeDefined();
    expect(spec.character_lock.name).toBe('Linda');
    expect(spec.segments).toBeDefined();
    expect(spec.segments).toHaveLength(8);
    for (const seg of spec.segments) {
      expect(seg.dialogue.trim().length).toBeGreaterThan(0);
      expect(seg.sceneDirection.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('Polish-23 Commit 3.0.26: POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT — PERSONA MIRROR authority + Linda-as-template pins', () => {
  it('names PERSONA MIRROR as the AUTHORITATIVE identity source', () => {
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain('AUTHORITATIVE SOURCE');
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain('PERSONA MIRROR PRIORITY');
  });

  it('names Linda as a STRUCTURAL TEMPLATE, not an identity source', () => {
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain('LINDA ANCHOR ROLE');
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain('STRUCTURAL TEMPLATE');
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain(
      'Linda is a stylistic guide only, NOT an identity source.',
    );
  });

  it('states verbatim gender-match constraint', () => {
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain(
      'character_lock.gender in your output MUST equal the mirror',
    );
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toMatch(
      /If PERSONA MIRROR says gender=male, output character_lock\.gender/,
    );
  });

  it('DIALOGUE RULES section from Commit 3.0.23 still present (no regression from prior pins)', () => {
    // Explicit belt-and-suspenders: the PERSONA MIRROR PRIORITY
    // block was inserted BEFORE the CHARACTER RULES / SEGMENT RULES /
    // DIALOGUE RULES sections. Confirm none of those were dropped.
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain('CHARACTER RULES:');
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain('SEGMENT RULES:');
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain('DIALOGUE RULES');
    expect(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT).toContain('NEVER quote another person');
  });
});

describe('Polish-23 Commit 3.0.28: getPolish23AdSpecSystemPrompt — persona-mirror mode strips Linda anchor', () => {
  it('hasPersonaMirror=true returns the persona-mirror system prompt (NO Linda examples)', () => {
    const p = getPolish23AdSpecSystemPrompt({ hasPersonaMirror: true });
    expect(p).toBe(POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT);
  });

  it('hasPersonaMirror=false returns the fallback (Linda-anchored) system prompt', () => {
    const p = getPolish23AdSpecSystemPrompt({ hasPersonaMirror: false });
    expect(p).toBe(POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT);
  });

  it('persona-mirror variant contains NO Linda-shaped bullet examples', () => {
    // Real breakthrough from job forensics: Linda examples in the
    // system prompt overpowered the user-message PERSONA MIRROR
    // HARD CONSTRAINT because Claude weighs system > user on
    // conflict. Persona-mirror variant MUST omit every Linda
    // template reference.
    const p = POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT;
    expect(p).not.toContain('suburban grandmother');
    expect(p).not.toContain('Shoulder-length salt-and-pepper hair');
    expect(p).not.toContain('Faded navy cotton crewneck');
    expect(p).not.toContain('Warm hazel eyes');
    expect(p).not.toContain('Ordinary nose, slight bump');
    expect(p).not.toContain('Sitting at her kitchen table');
    // "Linda" as a name must NOT appear anywhere in the persona
    // variant. The word "salt-and-pepper" doesn't either.
    expect(p).not.toContain('Linda');
    expect(p).not.toContain('salt-and-pepper');
  });

  it('persona-mirror variant names PERSONA-MIRROR MODE + HARD CONSTRAINT rules', () => {
    const p = POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT;
    expect(p).toContain('PERSONA-MIRROR MODE');
    expect(p).toContain('HARD CONSTRAINT');
    expect(p).toContain('character_lock.gender MUST equal the mirror');
    expect(p).toContain('a wrong output on any of them');
  });

  it('persona-mirror variant keeps SEGMENT RULES / DIALOGUE RULES / CRITICAL sections intact', () => {
    const p = POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT;
    expect(p).toContain('SEGMENT RULES:');
    expect(p).toContain('DIALOGUE RULES');
    expect(p).toContain('CRITICAL:');
    expect(p).toContain('NEVER quote another person');
    expect(p).toContain('EXACTLY 8 segments');
  });

  it('persona-mirror variant is materially shorter than the Linda-anchored variant (Linda examples consume ~1000 chars)', () => {
    // Regression pin: if a future edit accidentally re-adds Linda
    // examples to the persona-mirror variant, the char count would
    // climb back into fallback territory. Fail loud.
    const persona = POLISH23_CLAUDE_ADSPEC_PERSONA_MIRROR_SYSTEM_PROMPT;
    const fallback = POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT;
    // Both are substantive (>3000 chars) — the delta is a signal.
    expect(persona.length).toBeGreaterThan(2500);
    expect(fallback.length).toBeGreaterThan(persona.length);
  });

  it('fallback variant still contains the Linda template (regression pin — no-persona flows still work)', () => {
    const p = POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT;
    expect(p).toContain('suburban grandmother');
    expect(p).toContain('Shoulder-length salt-and-pepper hair');
    expect(p).toContain('LINDA ANCHOR ROLE');
  });
});

describe('Polish-23 Commit 3: character-lock lifecycle invariants (regression pins)', () => {
  it('AdSpecSchema keeps character_lock and segments in ONE object (composed once, shared verbatim)', () => {
    const spec = fallbackPolish23AdSpec();
    const parsed = AdSpecSchema.parse(spec);
    // A worker that re-derived character_lock per segment would need
    // it inside each SegmentSpec — pin the top-level anchor.
    expect(parsed).toHaveProperty('character_lock');
    expect(parsed).toHaveProperty('segments');
    // SegmentSpec must NOT contain a character_lock field (would
    // signal a rewrite that let per-clip drift creep in).
    for (const seg of parsed.segments) {
      expect(seg).not.toHaveProperty('character_lock');
    }
  });
});

describe('Polish-23 Commit 3.0.23: containsQuotedThirdPartySpeech — Google Veo TTS guard', () => {
  it('matches the EXACT job 03a…64 clip 6 failure dialogue', () => {
    const failing =
      "So I hit up my old buddy Frank who's been retired five years. He said, " +
      "'David, just enjoy it. But my brain kept buzzing.'";
    expect(containsQuotedThirdPartySpeech(failing)).toBe(true);
  });

  it('matches straight double-quoted third-party speech', () => {
    expect(containsQuotedThirdPartySpeech('He said, "just enjoy retirement".')).toBe(true);
    expect(containsQuotedThirdPartySpeech('She told me "you\'ll be fine".')).toBe(true);
  });

  it('matches curly double-quoted third-party speech (U+201C U+201D)', () => {
    expect(containsQuotedThirdPartySpeech('He said, “just enjoy retirement”.')).toBe(true);
  });

  it('matches curly single-quoted content (U+2018 U+2019, 5+ chars)', () => {
    expect(containsQuotedThirdPartySpeech('She said ‘just enjoy it, David’ to me.')).toBe(true);
  });

  it('matches attribution + straight-single-quoted CAPITAL-start content', () => {
    expect(
      containsQuotedThirdPartySpeech("She said, 'David, take it easy for once in your life'"),
    ).toBe(true);
    expect(containsQuotedThirdPartySpeech("He told me, 'Frank told me to enjoy it'")).toBe(true);
  });

  it('does NOT false-positive on contraction pairs like "I said I\'m fine and she said that\'s it"', () => {
    // Two contraction apostrophes 15+ chars apart used to false-positive.
    // Attribution regex requires capital letter AFTER opening apostrophe.
    expect(containsQuotedThirdPartySpeech("I said I'm fine and then she said that's all")).toBe(
      false,
    );
  });

  it('does NOT false-positive on inline contractions or possessives', () => {
    expect(
      containsQuotedThirdPartySpeech(
        "I don't think it's worth it, but my daughter's opinion matters too.",
      ),
    ).toBe(false);
    expect(
      containsQuotedThirdPartySpeech(
        "That's what I'd tell you if you were my age and I've been there.",
      ),
    ).toBe(false);
    expect(
      containsQuotedThirdPartySpeech(
        "If you're my age and tired of feeling tired, go grab a bottle.",
      ),
    ).toBe(false);
  });

  it('returns false for non-strings, empty, null, undefined', () => {
    expect(containsQuotedThirdPartySpeech('')).toBe(false);
    expect(containsQuotedThirdPartySpeech(null)).toBe(false);
    expect(containsQuotedThirdPartySpeech(undefined)).toBe(false);
    expect(containsQuotedThirdPartySpeech(42)).toBe(false);
    expect(containsQuotedThirdPartySpeech({ dialogue: 'He said, "hi"' })).toBe(false);
  });

  it('exports POLISH23_NESTED_QUOTE_PATTERNS as the exact 4-regex list (tripwire)', () => {
    expect(POLISH23_NESTED_QUOTE_PATTERNS).toHaveLength(4);
  });
});

describe('Polish-23 Commit 3.0.23: SegmentSpecSchema — Zod refine rejects nested-quote dialogue', () => {
  it('rejects the EXACT job 03a…64 clip 6 failure dialogue at parse time', () => {
    const bad = {
      dialogue:
        "So I hit up my old buddy Frank who's been retired five years. He said, " +
        "'David, just enjoy it. But my brain kept buzzing.'",
      sceneDirection: 'David leans back in his chair, contemplative.',
    };
    const parsed = SegmentSpecSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]!.message).toMatch(/quoted third-party speech/i);
    }
  });

  it('accepts paraphrased first-person indirect speech (the GOOD example)', () => {
    const good = {
      dialogue:
        "So I hit up my old buddy Frank who's been retired five years. Frank told me " +
        'to just enjoy retirement, but my brain kept buzzing anyway all day long here.',
      sceneDirection: 'David leans back in his chair, contemplative.',
    };
    const parsed = SegmentSpecSchema.safeParse(good);
    expect(parsed.success).toBe(true);
  });
});

describe('Polish-23 Commit 3.0.23: fallbackPolish23AdSpec — every fallback dialogue survives the new guard', () => {
  // Regression pin: if the fallback ever regresses to include a
  // nested-quote pattern, EVERY Polish-23 job that hits the
  // wholesale fallback path would fail Zod validation on the
  // fallback itself — locking the pipeline out of even the "give
  // up and ship Linda stock ad" recovery path.
  const fallback = fallbackPolish23AdSpec();
  for (const [i, seg] of fallback.segments.entries()) {
    it(`fallback segment ${i} dialogue passes containsQuotedThirdPartySpeech(=false)`, () => {
      expect(containsQuotedThirdPartySpeech(seg.dialogue)).toBe(false);
    });
    it(`fallback segment ${i} dialogue passes SegmentSpecSchema Zod refine`, () => {
      expect(SegmentSpecSchema.safeParse(seg).success).toBe(true);
    });
  }
});

describe('Polish-23 Commit 3.0.23: isValidSegment + assertAllSegmentsValid — belt-and-suspenders', () => {
  it('isValidSegment returns false when dialogue has nested quotes (bypasses schema path)', () => {
    const bad = {
      dialogue: "He said, 'David, just enjoy it. But my brain kept buzzing.'",
      sceneDirection: 'David leans back.',
    };
    expect(isValidSegment(bad)).toBe(false);
  });

  it('assertAllSegmentsValid throws with a nested-quote diagnostic message', () => {
    const spec = fallbackPolish23AdSpec();
    const mutated = spec.segments.slice();
    mutated[3] = {
      dialogue: "He said, 'David, just enjoy it. But my brain kept buzzing.'",
      sceneDirection: 'David leans back in his chair.',
    };
    expect(() => assertAllSegmentsValid(mutated)).toThrow(/quoted third-party speech/i);
  });
});
