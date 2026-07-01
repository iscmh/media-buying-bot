/**
 * Polish-19.2: pure-helper tests for the Veo 3.1 Fast worker.
 * Mirrors the Polish-19 Kling worker pattern — covers the pure
 * decision helpers the worker delegates to (poll backoff curve,
 * duration resolver) without spinning up Inngest's step harness.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VEO_EXTEND_INTER_CALL_DELAY_MS_DEFAULT,
  buildVeoDownloadHeaders,
  computeVeoPollIntervalSeconds,
  extractSourceScriptVerbatim,
  fallbackToSingleSegment,
  getVeoChainingMode,
  getVeoExtendInterCallDelayMs,
  parseVeoAdSpec,
  resolveAutoVeoDuration,
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

describe('Polish-19.3 Commit 2 — fan-out + stitch source shape', () => {
  // Source-shape tripwires for the multi-segment path. Catches
  // regressions like "future cleanup collapses parallel runs back
  // to sequential" or "stitch step gets dropped" before deploy.

  it('the worker fans out segments[] in parallel via Promise.all + runOneSegment', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/Promise\.all\(\s*adSpec\.segments\.map/);
    expect(src).toMatch(/runOneSegment\(/);
    // Tripwire — must NOT regress to a sequential for-loop over
    // segments which would N× the wall-clock.
    expect(src).not.toMatch(/for\s*\(const\s+seg\s+of\s+adSpec\.segments\)/);
  });

  it('the multi-segment guard fails fast when REPLICATE_VIDEO_CONCAT_MODEL_ID is unset', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/adSpec\.segments\.length > 1 && !isVideoConcatEnabled\(\)/);
    expect(src).toMatch(/REPLICATE_VIDEO_CONCAT_MODEL_ID/);
  });

  it('the worker calls runVeoStitch only when successSegments.length > 1', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/if \(successSegments\.length > 1\) \{[\s\S]*?runVeoStitch/);
  });

  it('per-segment rows use isClipPart=true + format _segment + clipIndex', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/insert-segment-rows-/);
    expect(src).toMatch(/format: 'veo_3_1_fast_native_audio_segment'/);
    expect(src).toMatch(/clipIndex: s\.segmentIndex/);
    expect(src).toMatch(/isClipPart: true/);
  });

  it('composite row uses isClipPart=false + the canonical pipeline format', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/insert-composite-/);
    expect(src).toMatch(/isClipPart: false/);
    expect(src).toMatch(/format: 'veo_3_1_fast_native_audio'/);
    // Composite's metadata must record actual segments_generated (not
    // requested) so the operator sees real coverage in the audit log.
    expect(src).toMatch(/segment_count_generated: successSegments\.length/);
  });

  it('runVeoStitch uses the kling BYOK key + Polish-9.12 submitReplicateConcat helper', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/loadDecryptedKeys\(userId, \['kling'\]\)/);
    expect(src).toMatch(/submitReplicateConcat/);
    expect(src).toMatch(/checkReplicateConcat/);
  });

  it('8s single-segment path still bypasses stitch (back-compat with Polish-19.2)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    // The `compositeUrl = segmentUrls[0]!` default + the
    // conditional stitch means single-segment runs write the
    // segment URL directly as the composite. Tripwire against
    // a regression that would always stitch (would 422 on a
    // single-input concat).
    expect(src).toMatch(/let compositeUrl = segmentUrls\[0\]!/);
    expect(src).toMatch(/let stitched = false/);
  });
});

describe('Polish-19.3.1: resolveAutoVeoDuration — fallback chain', () => {
  it('null metadata → default source (4 segments / 32s)', () => {
    const r = resolveAutoVeoDuration(null);
    expect(r.source).toBe('default');
    expect(r.segmentCount).toBe(4);
    expect(r.durationSeconds).toBe(32);
    expect(r.sourceDurationSeconds).toBeNull();
  });

  it('empty metadata object → default source', () => {
    const r = resolveAutoVeoDuration({});
    expect(r.source).toBe('default');
    expect(r.segmentCount).toBe(4);
  });

  it('analysis.video_duration_seconds wins when present (vision-derived)', () => {
    const r = resolveAutoVeoDuration({
      analysis: { video_duration_seconds: 12 },
      source_duration_seconds: 30, // would normally fire; analysis wins
    });
    expect(r.source).toBe('analysis');
    expect(r.sourceDurationSeconds).toBe(12);
    expect(r.segmentCount).toBe(2); // 9-16s range → 2 segments
    expect(r.durationSeconds).toBe(16);
  });

  it('source_duration_seconds fires when analysis is missing (form-set legacy path)', () => {
    const r = resolveAutoVeoDuration({ source_duration_seconds: 25 });
    expect(r.source).toBe('form');
    expect(r.sourceDurationSeconds).toBe(25);
    expect(r.segmentCount).toBe(4); // 17-32s → 4 segments
    expect(r.durationSeconds).toBe(32);
  });

  it('ignores analysis when video_duration_seconds is missing / non-numeric', () => {
    const r = resolveAutoVeoDuration({
      analysis: { script_transcription: 'something else' },
      source_duration_seconds: 10,
    });
    expect(r.source).toBe('form');
    expect(r.segmentCount).toBe(2);
  });

  it('ignores form value when zero / negative / non-numeric', () => {
    expect(resolveAutoVeoDuration({ source_duration_seconds: 0 }).source).toBe('default');
    expect(resolveAutoVeoDuration({ source_duration_seconds: -5 }).source).toBe('default');
    expect(resolveAutoVeoDuration({ source_duration_seconds: 'twelve' }).source).toBe('default');
  });

  it('returned durationSeconds is always segmentCount × 8 (worker-billable)', () => {
    expect(
      resolveAutoVeoDuration({ analysis: { video_duration_seconds: 5 } }).durationSeconds,
    ).toBe(8);
    expect(
      resolveAutoVeoDuration({ analysis: { video_duration_seconds: 14 } }).durationSeconds,
    ).toBe(16);
    expect(
      resolveAutoVeoDuration({ analysis: { video_duration_seconds: 30 } }).durationSeconds,
    ).toBe(32);
    expect(
      resolveAutoVeoDuration({ analysis: { video_duration_seconds: 50 } }).durationSeconds,
    ).toBe(64);
  });
});

describe('Polish-19.3.1: Veo worker switched to resolveAutoVeoDuration (source pin)', () => {
  it('worker live path uses resolveAutoVeoDuration (not the old resolveVeoTargetDuration)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    // The variant-loop call site must use the auto resolver. The
    // old resolveVeoTargetDuration export stays for back-compat /
    // tests but should NOT be called from the live worker path.
    expect(src).toMatch(/resolveAutoVeoDuration\(/);
    // Tripwire — the live-path call to resolveVeoTargetDuration
    // (the pre-19.3.1 single-segment per-call clamp) must be gone.
    // Match the specific call inside the worker createFunction
    // closure, NOT the export declaration line.
    expect(src).not.toMatch(/= resolveVeoTargetDuration\(/);
  });

  it('worker logs the fallback-chain source per job for diagnosability', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/auto-duration resolved/);
    expect(src).toMatch(/autoDuration\.source/);
  });
});

describe('Polish-19.4: getVeoChainingMode env reader', () => {
  const realEnv = process.env;
  beforeEach(() => {
    process.env = { ...realEnv };
    delete process.env.VEO_CHAINING_MODE;
  });
  afterEach(() => {
    process.env = realEnv;
  });

  it('defaults to "extend" when env var is unset (new Polish-19.4 default)', () => {
    expect(getVeoChainingMode()).toBe('extend');
  });

  it('returns "concat" when env is exactly "concat" (operator fallback flip)', () => {
    process.env.VEO_CHAINING_MODE = 'concat';
    expect(getVeoChainingMode()).toBe('concat');
  });

  it('case-insensitive on "concat" (operator typed "CONCAT" in Vercel dashboard)', () => {
    process.env.VEO_CHAINING_MODE = 'CONCAT';
    expect(getVeoChainingMode()).toBe('concat');
    process.env.VEO_CHAINING_MODE = 'Concat';
    expect(getVeoChainingMode()).toBe('concat');
  });

  it('treats whitespace + empty as "extend" (defaults-safe)', () => {
    process.env.VEO_CHAINING_MODE = '   ';
    expect(getVeoChainingMode()).toBe('extend');
    process.env.VEO_CHAINING_MODE = '';
    expect(getVeoChainingMode()).toBe('extend');
  });

  it('any other value resolves to "extend" (typo-safe)', () => {
    process.env.VEO_CHAINING_MODE = 'parallel';
    expect(getVeoChainingMode()).toBe('extend');
    process.env.VEO_CHAINING_MODE = 'stitch';
    expect(getVeoChainingMode()).toBe('extend');
  });
});

describe('Polish-19.4: worker dispatch + extend chain source shape', () => {
  // Tripwires for the multi-mode worker. Catches regressions like
  // "the dispatcher was deleted and concat path runs unconditionally"
  // before deploy.

  it('runOneVariant dispatches on chain mode (extend vs concat)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/const mode = getVeoChainingMode\(\)/);
    expect(src).toMatch(/if \(mode === 'extend'\) \{[\s\S]*?runOneVariantExtend\(input\)/);
    expect(src).toMatch(/return runOneVariantConcat\(input\)/);
  });

  it('extend runner forces durationSeconds=8 + resolution="720p" on the base segment', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    // The base call MUST be 8s (Google rejects 4s/6s before Extend)
    // AND 720p (the Extend chain rejects 1080p/4k).
    expect(src).toMatch(/durationSeconds: VEO_MAX_SECONDS_PER_CALL/);
    expect(src).toMatch(/resolution: '720p'/);
  });

  it('extend runner calls submitVeoExtend with the previous video URI for each subsequent segment', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/submitVeoExtend\(/);
    expect(src).toMatch(/previousVideo: \{ uri: previousVideoUri/);
    // Tripwire — the chain is SEQUENTIAL (each extend uses the
    // PREVIOUS operation's URI). A regression that parallelized
    // would break character continuity. Match the for-loop that
    // walks segments[1..] and updates chainVideoUri.
    expect(src).toMatch(/for \(let segIdx = 1; segIdx < adSpec\.segments\.length; segIdx\+\+\)/);
    expect(src).toMatch(/chainVideoUri = ext\.videoUri/);
  });

  it('extend runner uploads the FINAL chain video (no concat step)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    // After the chain, the FINAL operation's video URI is uploaded
    // as the composite. There must be NO call to submitReplicateConcat
    // inside the extend path (only in the concat path).
    expect(src).toMatch(/veo-extend-upload-/);
    expect(src).toMatch(/remoteUrl: chainVideoUri/);
  });

  it('extend runner writes ONE composite row (no per-segment rows — extend output is cumulative)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/insert-composite-extend-/);
    expect(src).toMatch(/chaining_mode: 'extend'/);
    expect(src).toMatch(/resolution: '720p'/);
    // The extend path must NOT use insert-segment-rows-* (those are
    // for the concat path where each segment is a discrete chunk).
    const extendRunnerSrc =
      src.split('runOneVariantExtend')[1]?.split('runOneVariantConcat')[0] ?? '';
    expect(extendRunnerSrc).not.toMatch(/insert-segment-rows-/);
  });

  it('extend runner bills $1.20 base + $1.05 per extend (8s × $0.15 + 7s × $0.15)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    // Bills via estimateVeoCostUsd per call, using the Extend
    // constants from ai-providers (VEO_MAX_SECONDS_PER_CALL = 8 base,
    // VEO_EXTEND_SECONDS_PER_CALL = 7 per extend).
    expect(src).toMatch(/estimateVeoCostUsd\(VEO_MAX_SECONDS_PER_CALL\)/);
    expect(src).toMatch(/estimateVeoCostUsd\(VEO_EXTEND_SECONDS_PER_CALL\)/);
  });

  it('output duration on the composite row = 8 + 7 × (N - 1)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    // Pin the exact math written into generationMetadata so a future
    // "let me just write segments.length * 8" regression fires here.
    expect(src).toMatch(
      /VEO_MAX_SECONDS_PER_CALL[\s+]+VEO_EXTEND_SECONDS_PER_CALL \* Math\.max\(0, adSpec\.segments\.length - 1\)/,
    );
  });

  it('concat path is preserved verbatim (Polish-19.3 logic kept as fallback)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    // The Polish-19.3 fan-out + stitch path stays alive behind the
    // chain-mode dispatcher.
    expect(src).toMatch(/runOneVariantConcat\(/);
    expect(src).toMatch(/Promise\.all\(\s*adSpec\.segments\.map/);
    expect(src).toMatch(/runVeoStitch/);
  });
});

describe('Polish-19.4.2: extractSourceScriptVerbatim', () => {
  it('returns metadata.analysis.script_transcription when present', () => {
    const r = extractSourceScriptVerbatim({
      analysis: {
        script_transcription:
          'I swear to god, I was spending $80 a month on face serums that did NOTHING.',
      },
    });
    expect(r).toContain('I swear to god');
    expect(r).toContain('$80');
    expect(r).toContain('NOTHING');
  });

  it('returns empty string when metadata is null', () => {
    expect(extractSourceScriptVerbatim(null)).toBe('');
  });

  it('returns empty string when analysis is missing / not an object', () => {
    expect(extractSourceScriptVerbatim({})).toBe('');
    expect(extractSourceScriptVerbatim({ analysis: null })).toBe('');
    expect(extractSourceScriptVerbatim({ analysis: 'string' })).toBe('');
    expect(extractSourceScriptVerbatim({ analysis: 42 })).toBe('');
  });

  it('returns empty string when script_transcription is missing / not a string', () => {
    expect(extractSourceScriptVerbatim({ analysis: {} })).toBe('');
    expect(extractSourceScriptVerbatim({ analysis: { script_transcription: null } })).toBe('');
    expect(extractSourceScriptVerbatim({ analysis: { script_transcription: 42 } })).toBe('');
  });

  it('preserves markers verbatim ((pause), [tone], ellipses, ALL CAPS)', () => {
    // Per the shared Sora prompt schema, transcription is a string
    // "with (pause) and [tone] markers". The helper is a passthrough,
    // NOT a normalizer — those markers must survive.
    const raw = 'You WILL NOT believe... (pause) [excited] this $12 drugstore toner is INSANE.';
    const r = extractSourceScriptVerbatim({ analysis: { script_transcription: raw } });
    expect(r).toBe(raw);
  });
});

describe('Polish-19.4.2: parseVeoAdSpec carries sound_texture through', () => {
  it('parses segments with sound_texture emitted by Claude', () => {
    const withSound = JSON.stringify({
      segments: [
        {
          index: 0,
          prompt: "She says: 'I swear to god...'",
          sound_texture: 'Close-mic iPhone front-camera compression, faint room tone, no music.',
        },
        {
          index: 1,
          prompt: "She confesses: '...'",
          sound_texture: 'Static tripod audio, air conditioner hum, no music.',
        },
      ],
    });
    const r = parseVeoAdSpec(withSound);
    expect(r?.segments).toHaveLength(2);
    expect(r?.segments[0]?.sound_texture).toBe(
      'Close-mic iPhone front-camera compression, faint room tone, no music.',
    );
    expect(r?.segments[1]?.sound_texture).toBe(
      'Static tripod audio, air conditioner hum, no music.',
    );
  });

  it('parses segments WITHOUT sound_texture (back-compat with pre-19.4.2 responses)', () => {
    // Pre-19.4.2 the field didn't exist. Cached specs / older Claude
    // responses that omit it must still validate — parser stays
    // tolerant.
    const withoutSound = JSON.stringify({
      segments: [{ index: 0, prompt: "She says: 'hi'" }],
    });
    const r = parseVeoAdSpec(withoutSound);
    expect(r?.segments).toHaveLength(1);
    expect(r?.segments[0]?.sound_texture).toBeUndefined();
  });

  it('drops empty-string sound_texture (treated as absent)', () => {
    const r = parseVeoAdSpec(
      JSON.stringify({
        segments: [{ index: 0, prompt: 'p', sound_texture: '' }],
      }),
    );
    expect(r?.segments[0]?.sound_texture).toBeUndefined();
  });

  it('drops non-string sound_texture (defensive against Claude misfires)', () => {
    const r = parseVeoAdSpec(
      JSON.stringify({
        segments: [{ index: 0, prompt: 'p', sound_texture: 42 }],
      }),
    );
    // Still validates (sound_texture is optional) but the bad value
    // is dropped, not surfaced as a garbage field.
    expect(r).not.toBeNull();
    expect(r?.segments[0]?.sound_texture).toBeUndefined();
  });
});

describe('Polish-19.4.2: runClaudeAdSpec systemPrompt tripwires', () => {
  // The system prompt is a big string literal inside runClaudeAdSpec.
  // These tripwires pin the parts that materially affect output
  // quality per the Polish-19.4.2 spec — a future "let me trim this
  // prompt" cleanup must NOT drop any of these without a doc note.

  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
  };

  it('word-count calibration: segment 0 = 22-28 words, extends = 18-24 words', async () => {
    const src = await readSrc();
    expect(src).toMatch(/22-28 words/);
    expect(src).toMatch(/18-24 words/);
    // Yapping-pace reference (~170wpm — the actual UGC talking speed,
    // above the 150wpm we were quoting in 19.4 which underfilled the
    // 8s window and let Veo pad with dead air / lip-flap).
    expect(src).toMatch(/~170wpm/);
  });

  it('word-count comment pins base=8s / extends=+7s alignment', async () => {
    // Guardrail — if a future edit says "22-28 words for a 7s
    // segment", the word/second ratio breaks. This pins the mapping.
    const src = await readSrc();
    expect(src).toMatch(/Segment 0 \(Veo base, 8s @ 720p\): 22-28 words/);
    expect(src).toMatch(/Segments 1\.\.N-1 \(Veo extend, \+7s each\): 18-24 words/);
  });

  it('preserve-hooks-not-verbatim block calls out what to PRESERVE vs ADAPT', async () => {
    const src = await readSrc();
    expect(src).toMatch(/PRESERVE:.*hook openers.*dollar amounts.*ALL CAPS/s);
    expect(src).toMatch(/ADAPT:.*character demographics.*setting details/s);
    expect(src).toMatch(/NOT verbatim quoting/i);
  });

  it('includes the worked "I swear to god / $80 / NOTHING" example inline', async () => {
    // The worked example anchors what "preserve hooks" looks like in
    // practice — much more effective in the prompt than an abstract
    // rule. Pinned so a future cleanup doesn't drop it.
    const src = await readSrc();
    expect(src).toMatch(/I swear to god/);
    expect(src).toMatch(/\$80/);
    expect(src).toMatch(/NOTHING/);
    expect(src).toMatch(/CORRECT segment 0/);
    expect(src).toMatch(/WRONG segment 0/);
  });

  it('speaker-attribution template ("She says:" / "He confesses:") is required', async () => {
    const src = await readSrc();
    expect(src).toMatch(/Speaker attribution \+ spoken dialogue in quotes/);
    expect(src).toMatch(/She says:/);
    expect(src).toMatch(/He confesses:/);
  });

  it('sound_texture field is in the schema block AND has example values', async () => {
    const src = await readSrc();
    // Schema pin
    expect(src).toMatch(/"sound_texture":/);
    // Example acoustic textures from the spec — at least one of the
    // canonical three must appear so Claude has a shape to copy.
    expect(src).toMatch(/Close-mic iPhone front-camera compression/);
    expect(src).toMatch(/faint traffic outside/);
    expect(src).toMatch(/air conditioner hum/);
  });

  it('user-message payload lifts source_script_verbatim to top level (not buried in source_analysis)', async () => {
    // Tripwire — the whole point of Polish-19.4.2 Part 2 is that
    // Claude sees the source script as a first-class field, NOT
    // buried inside a JSON dump next to twenty vision cues.
    const src = await readSrc();
    expect(src).toMatch(/source_script_verbatim: sourceScriptVerbatim/);
    expect(src).toMatch(/extractSourceScriptVerbatim\(jobMetadata\)/);
  });
});

describe('Polish-19.4.3: getVeoExtendInterCallDelayMs', () => {
  const realEnv = process.env;
  beforeEach(() => {
    process.env = { ...realEnv };
    delete process.env.VEO_EXTEND_INTER_CALL_DELAY_MS;
  });
  afterEach(() => {
    process.env = realEnv;
  });

  it('defaults to 2500ms when env is unset (documented rate-limit breather)', () => {
    expect(VEO_EXTEND_INTER_CALL_DELAY_MS_DEFAULT).toBe(2500);
    expect(getVeoExtendInterCallDelayMs()).toBe(2500);
  });

  it('honors integer env override', () => {
    process.env.VEO_EXTEND_INTER_CALL_DELAY_MS = '5000';
    expect(getVeoExtendInterCallDelayMs()).toBe(5000);
  });

  it('accepts 0 (disable inter-call pause entirely)', () => {
    process.env.VEO_EXTEND_INTER_CALL_DELAY_MS = '0';
    expect(getVeoExtendInterCallDelayMs()).toBe(0);
  });

  it('floors fractional values (step.sleep needs integer ms)', () => {
    process.env.VEO_EXTEND_INTER_CALL_DELAY_MS = '2500.7';
    expect(getVeoExtendInterCallDelayMs()).toBe(2500);
  });

  it('falls back to default on non-numeric / negative values', () => {
    for (const raw of ['', '   ', 'two-thousand', '-100', 'NaN']) {
      process.env.VEO_EXTEND_INTER_CALL_DELAY_MS = raw;
      expect(getVeoExtendInterCallDelayMs()).toBe(2500);
    }
  });
});

describe('Polish-19.4.3: extend runner threads inter-call pause between segments', () => {
  it('step.sleep runs with VEO_EXTEND_INTER_CALL_DELAY_MS ms between extend calls', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-veo-3-1-fast.ts', import.meta.url),
      'utf8',
    );
    // The pause fires INSIDE the extend loop, BEFORE each extend
    // call (segIdx >= 1). Tripwire: a future cleanup that moves it
    // out of the loop or drops it would let a 60s ad chain fire 8
    // back-to-back calls again.
    expect(src).toMatch(/veo-extend-pause-\$\{variantIndex\}-\$\{segIdx\}/);
    expect(src).toMatch(/getVeoExtendInterCallDelayMs\(\)/);
    // Only pauses when interCallDelayMs > 0 (operator-disabled case).
    expect(src).toMatch(/if \(interCallDelayMs > 0\)/);
  });
});
