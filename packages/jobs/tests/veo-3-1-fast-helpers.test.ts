/**
 * Polish-19.2: pure-helper tests for the Veo 3.1 Fast worker.
 * Mirrors the Polish-19 Kling worker pattern — covers the pure
 * decision helpers the worker delegates to (poll backoff curve,
 * duration resolver) without spinning up Inngest's step harness.
 */
import { describe, expect, it } from 'vitest';
import {
  buildVeoDownloadHeaders,
  computeVeoPollIntervalSeconds,
  fallbackToSingleSegment,
  parseVeoAdSpec,
  resolveVeoTargetDuration,
} from '../src/functions/generate-veo-3-1-fast';

describe('Polish-19.2: computeVeoPollIntervalSeconds', () => {
  it('attempt 0 returns the initial interval (8s)', () => {
    expect(computeVeoPollIntervalSeconds(0)).toBe(8);
  });

  it('grows gently in the first several attempts (1.15x growth)', () => {
    // 8 * 1.15 = 9.2 → ceil = 10
    // 8 * 1.15^2 = 10.58 → ceil = 11
    // 8 * 1.15^3 = 12.17 → ceil = 13
    expect(computeVeoPollIntervalSeconds(1)).toBe(10);
    expect(computeVeoPollIntervalSeconds(2)).toBe(11);
    expect(computeVeoPollIntervalSeconds(3)).toBe(13);
  });

  it('caps at 25s on later attempts', () => {
    expect(computeVeoPollIntervalSeconds(20)).toBe(25);
    expect(computeVeoPollIntervalSeconds(59)).toBe(25);
  });

  it('clamps non-finite / negative attempt indices to the initial interval', () => {
    expect(computeVeoPollIntervalSeconds(NaN)).toBe(8);
    expect(computeVeoPollIntervalSeconds(-2)).toBe(8);
    expect(computeVeoPollIntervalSeconds(Infinity)).toBe(8);
  });

  it('total wall-clock with POLL_MAX_ATTEMPTS=60 stays above 15 minutes', () => {
    // Sanity bound — needs enough headroom past observed Veo runtime.
    let total = 0;
    for (let i = 0; i < 60; i++) total += computeVeoPollIntervalSeconds(i);
    expect(total).toBeGreaterThan(15 * 60);
    expect(total).toBeLessThan(45 * 60);
  });
});

describe('Polish-19.2: resolveVeoTargetDuration', () => {
  it('defaults to 8s (Veo per-call ceiling) when metadata is null', () => {
    const r = resolveVeoTargetDuration(null);
    expect(r.durationSeconds).toBe(8);
    expect(r.clamped).toBe(false);
  });

  it('defaults to 8s when source_duration_seconds is missing or invalid', () => {
    expect(resolveVeoTargetDuration({ other: 'field' }).durationSeconds).toBe(8);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 'twelve' }).durationSeconds).toBe(8);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 0 }).durationSeconds).toBe(8);
    expect(resolveVeoTargetDuration({ source_duration_seconds: NaN }).durationSeconds).toBe(8);
    expect(resolveVeoTargetDuration({ source_duration_seconds: -3 }).durationSeconds).toBe(8);
  });

  it('passes mid-range durations under the cap straight through', () => {
    expect(resolveVeoTargetDuration({ source_duration_seconds: 4 }).durationSeconds).toBe(4);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 6 }).durationSeconds).toBe(6);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 8 }).durationSeconds).toBe(8);
  });

  it('clamps requests above 8s to 8s and flags clamped=true', () => {
    const r = resolveVeoTargetDuration({ source_duration_seconds: 30 });
    expect(r.durationSeconds).toBe(8);
    expect(r.clamped).toBe(true);
    expect(r.requestedSeconds).toBe(30);
  });

  it('rounds fractional seconds up to the next whole second', () => {
    expect(resolveVeoTargetDuration({ source_duration_seconds: 4.3 }).durationSeconds).toBe(5);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 5.9 }).durationSeconds).toBe(6);
  });

  it('reports clamped=false when the request is exactly at the cap', () => {
    const r = resolveVeoTargetDuration({ source_duration_seconds: 8 });
    expect(r.clamped).toBe(false);
  });
});

describe('Polish-19.2.4: buildVeoDownloadHeaders', () => {
  // Veo's output URI on the Gemini Developer API is a private Files
  // API URL that 403s without the x-goog-api-key header. Public CDN
  // URIs (kie.ai, Replicate, Supabase) must NOT receive the unrelated
  // Gemini key.

  it('attaches x-goog-api-key for generativelanguage.googleapis.com URIs', () => {
    const headers = buildVeoDownloadHeaders(
      'https://generativelanguage.googleapis.com/v1beta/files/2kpilk04g35q:download?alt=media',
      'test-api-key-abc',
    );
    expect(headers).toEqual({ 'x-goog-api-key': 'test-api-key-abc' });
  });

  it('does NOT attach the key for kie.ai CDN URIs (Kling Avatar v2 path)', () => {
    expect(
      buildVeoDownloadHeaders(
        'https://file.aiquickdraw.com/custom-page/akr/section-images/output.mp4',
        'test-api-key-abc',
      ),
    ).toBeUndefined();
  });

  it('does NOT attach the key for Replicate delivery URIs (Polish-9.12 path)', () => {
    expect(
      buildVeoDownloadHeaders('https://replicate.delivery/abc/output.mp4', 'test-api-key-abc'),
    ).toBeUndefined();
  });

  it('does NOT attach the key for Supabase Storage URIs (already in our bucket)', () => {
    expect(
      buildVeoDownloadHeaders(
        'https://xxxx.supabase.co/storage/v1/object/public/generated-creatives/u/job/file.mp4',
        'test-api-key-abc',
      ),
    ).toBeUndefined();
  });

  it('handles case-insensitive host match (defensive against URL normalization)', () => {
    const headers = buildVeoDownloadHeaders(
      'https://GenerativeLanguage.GoogleAPIs.com/v1beta/files/abc',
      'k',
    );
    expect(headers).toEqual({ 'x-goog-api-key': 'k' });
  });

  it('returns undefined for empty / malformed URLs', () => {
    expect(buildVeoDownloadHeaders('', 'k')).toBeUndefined();
    expect(buildVeoDownloadHeaders('not-a-url', 'k')).toBeUndefined();
  });

  it('does NOT match Vertex AI storage hosts (different auth flow, gs:// or signed URLs)', () => {
    expect(
      buildVeoDownloadHeaders('https://storage.googleapis.com/veo-output/abc.mp4', 'k'),
    ).toBeUndefined();
  });
});

describe('Polish-19.3: parseVeoAdSpec', () => {
  const VALID = JSON.stringify({
    segments: [
      { index: 0, prompt: 'First 8s scene with hook dialogue...' },
      { index: 1, prompt: 'Next 8s with continued story...' },
    ],
  });

  it('parses a bare JSON segments[] response', () => {
    const r = parseVeoAdSpec(VALID);
    expect(r).not.toBeNull();
    expect(r?.segments).toHaveLength(2);
    expect(r?.segments[0]?.prompt).toContain('hook');
  });

  it('parses fenced ```json blocks (Claude habit)', () => {
    const fenced = '```json\n' + VALID + '\n```';
    expect(parseVeoAdSpec(fenced)?.segments).toHaveLength(2);
  });

  it('parses JSON wrapped in preamble prose (brace-bounded slice fallback)', () => {
    const wrapped = `Here is the spec: ${VALID}\nLet me know if you need changes.`;
    expect(parseVeoAdSpec(wrapped)?.segments).toHaveLength(2);
  });

  it('accepts an already-parsed object (validation-only path)', () => {
    const r = parseVeoAdSpec(JSON.parse(VALID));
    expect(r).not.toBeNull();
  });

  it('infers index from array position when omitted', () => {
    const noIndices = JSON.stringify({
      segments: [{ prompt: 'first' }, { prompt: 'second' }, { prompt: 'third' }],
    });
    const r = parseVeoAdSpec(noIndices);
    expect(r?.segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('honors explicit index values when Claude supplies them', () => {
    const explicit = JSON.stringify({
      segments: [
        { index: 5, prompt: 'a' },
        { index: 9, prompt: 'b' },
      ],
    });
    expect(parseVeoAdSpec(explicit)?.segments.map((s) => s.index)).toEqual([5, 9]);
  });

  it('returns null on empty segments array', () => {
    expect(parseVeoAdSpec(JSON.stringify({ segments: [] }))).toBeNull();
  });

  it('returns null when a segment is missing the prompt field', () => {
    expect(parseVeoAdSpec(JSON.stringify({ segments: [{ index: 0 }] }))).toBeNull();
  });

  it('returns null when a segment.prompt is empty string', () => {
    expect(parseVeoAdSpec(JSON.stringify({ segments: [{ prompt: '' }] }))).toBeNull();
  });

  it('returns null on completely malformed input', () => {
    expect(parseVeoAdSpec('not json')).toBeNull();
    expect(parseVeoAdSpec('')).toBeNull();
    expect(parseVeoAdSpec(null)).toBeNull();
    expect(parseVeoAdSpec(undefined)).toBeNull();
    expect(parseVeoAdSpec({ wrongShape: true })).toBeNull();
  });
});

describe('Polish-19.3: fallbackToSingleSegment', () => {
  it('wraps plain text as a single-segment ad spec', () => {
    const r = fallbackToSingleSegment('Some plain-text ad spec...');
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]?.index).toBe(0);
    expect(r.segments[0]?.prompt).toBe('Some plain-text ad spec...');
  });

  it('produces output that round-trips through parseVeoAdSpec validation', () => {
    const fb = fallbackToSingleSegment('text');
    const reparsed = parseVeoAdSpec(fb);
    expect(reparsed).not.toBeNull();
    expect(reparsed?.segments).toHaveLength(1);
  });
});

describe('Polish-19.3: Commit 1 invariant — worker reads segments[0] only', () => {
  // Source-shape tripwire. Commit 2 lifts this to a fan-out + concat
  // loop. Until then, the worker MUST only consume segments[0] so
  // the runtime stays back-compat with Polish-19.2 single-chunk
  // behavior for 8s picks.
  it('the submit call uses adSpec.segments[0].prompt (NOT the full segments array joined)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/prompt: adSpec\.segments\[0\]!\.prompt/);
    // Tripwire — must not regress to a join() pattern that would
    // cram all segment prompts into one Veo call.
    expect(src).not.toMatch(/segments\.map[^)]*\)\.join/);
  });

  it('the worker persists full segments[] + segment_count_generated=1 on the creative row', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/segment_count_requested: segmentCount/);
    expect(src).toMatch(/segment_count_generated: 1/);
    expect(src).toMatch(/segments: adSpec\.segments/);
  });
});
