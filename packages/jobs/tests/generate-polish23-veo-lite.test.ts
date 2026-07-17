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
  POLISH23_CLIP_SECONDS,
  POLISH23_SEGMENT_COUNT,
  composePolish23AdSpecUserPrompt,
  fallbackPolish23AdSpec,
  parsePolish23AdSpec,
} from '../src/lib/polish23-claude-adspec-prompt';
import {
  computePolish23Progress,
  computePolish23SegmentProgress,
  extractSourceScript,
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
