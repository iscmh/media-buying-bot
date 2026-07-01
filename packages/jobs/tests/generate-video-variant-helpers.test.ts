/**
 * Polish-20 Commit 2: pure-helper tests for the unified video-variant
 * worker. Covers the decision helpers the worker delegates to (poll
 * backoff, duration resolution, per-model word-count calibration,
 * per-call clamping, source-script extraction) plus segments[] parser
 * + source-shape tripwires against the worker's dispatch shape.
 */
import { describe, expect, it } from 'vitest';
import { getVideoModel } from '@mbb/shared';
import {
  clampPerCallSeconds,
  computeVideoPollIntervalSeconds,
  computeWordCountRangePerSegment,
  extractSourceScriptVerbatim,
  fallbackToSingleSegment,
  parseVideoAdSpec,
  resolveAutoVideoDuration,
} from '../src/functions/generate-video-variant';

describe('Polish-20: computeVideoPollIntervalSeconds', () => {
  it('attempt 0 returns the 8s initial interval', () => {
    expect(computeVideoPollIntervalSeconds(0)).toBe(8);
  });

  it('grows gently in the first several attempts (1.15x growth)', () => {
    expect(computeVideoPollIntervalSeconds(1)).toBe(10);
    expect(computeVideoPollIntervalSeconds(2)).toBe(11);
    expect(computeVideoPollIntervalSeconds(3)).toBe(13);
  });

  it('caps at 25s', () => {
    expect(computeVideoPollIntervalSeconds(20)).toBe(25);
    expect(computeVideoPollIntervalSeconds(80)).toBe(25);
  });

  it('clamps non-finite / negative to initial', () => {
    expect(computeVideoPollIntervalSeconds(NaN)).toBe(8);
    expect(computeVideoPollIntervalSeconds(-2)).toBe(8);
    expect(computeVideoPollIntervalSeconds(Infinity)).toBe(8);
  });

  it('total wall-clock over 80 attempts stays above 20 minutes', () => {
    let total = 0;
    for (let i = 0; i < 80; i++) total += computeVideoPollIntervalSeconds(i);
    expect(total).toBeGreaterThan(20 * 60);
    expect(total).toBeLessThan(45 * 60);
  });
});

describe('Polish-20: resolveAutoVideoDuration (Polish-19.3.1 fallback chain, per-model segment count)', () => {
  const kling = getVideoModel('kling_3_standard')!;
  const s15pro = getVideoModel('seedance_1_5_pro')!;

  it('null metadata → default 30s, 2 segs on Kling (15s cap), 3 segs on Seedance 1.5 (12s cap)', () => {
    const rk = resolveAutoVideoDuration(null, kling);
    expect(rk.source).toBe('default');
    expect(rk.targetSeconds).toBe(30);
    expect(rk.segmentCount).toBe(2);
    const rs = resolveAutoVideoDuration(null, s15pro);
    expect(rs.targetSeconds).toBe(30);
    expect(rs.segmentCount).toBe(3);
  });

  it('analysis.video_duration_seconds wins over form-picked (vision-derived)', () => {
    const r = resolveAutoVideoDuration(
      {
        analysis: { video_duration_seconds: 12 },
        source_duration_seconds: 30, // ignored
      },
      kling,
    );
    expect(r.source).toBe('analysis');
    expect(r.sourceDurationSeconds).toBe(12);
    expect(r.targetSeconds).toBe(12);
    expect(r.segmentCount).toBe(1); // ≤15s → 1 segment on Kling
  });

  it('source_duration_seconds fires when analysis is missing', () => {
    const r = resolveAutoVideoDuration({ source_duration_seconds: 25 }, s15pro);
    expect(r.source).toBe('form');
    expect(r.sourceDurationSeconds).toBe(25);
    expect(r.targetSeconds).toBe(25);
    expect(r.segmentCount).toBe(3); // ceil(25/12) = 3
  });

  it('ignores non-numeric / non-positive analysis + form values', () => {
    expect(
      resolveAutoVideoDuration(
        { analysis: { video_duration_seconds: 'twelve' }, source_duration_seconds: 10 },
        kling,
      ).source,
    ).toBe('form');
    expect(resolveAutoVideoDuration({ source_duration_seconds: 0 }, kling).source).toBe('default');
    expect(resolveAutoVideoDuration({ source_duration_seconds: -3 }, kling).source).toBe('default');
  });
});

describe('Polish-20: computeWordCountRangePerSegment (per-model calibration)', () => {
  it('scales to ~170wpm × secondsPerCall / 60', () => {
    const s15pro = getVideoModel('seedance_1_5_pro')!; // 12s cap
    const kling = getVideoModel('kling_3_standard')!; // 15s cap
    const s2 = getVideoModel('seedance_2')!; // 15s cap

    const ws15 = computeWordCountRangePerSegment(s15pro);
    // 12s × 170wpm / 60 = 34 central → [.85, 1.05] ≈ [29, 36]
    expect(ws15.min).toBeGreaterThanOrEqual(28);
    expect(ws15.min).toBeLessThanOrEqual(30);
    expect(ws15.max).toBeGreaterThanOrEqual(34);
    expect(ws15.max).toBeLessThanOrEqual(37);

    const wk = computeWordCountRangePerSegment(kling);
    // 15s × 170wpm / 60 = 42.5 central → ≈ [36, 45]
    expect(wk.min).toBeGreaterThanOrEqual(35);
    expect(wk.min).toBeLessThanOrEqual(38);
    expect(wk.max).toBeGreaterThanOrEqual(43);
    expect(wk.max).toBeLessThanOrEqual(46);

    // Seedance 2 shares the 15s cap so window matches Kling.
    const ws2 = computeWordCountRangePerSegment(s2);
    expect(ws2).toEqual(wk);
  });

  it('every window keeps min < max (never inverted)', () => {
    for (const modelId of ['seedance_1_5_pro', 'kling_3_standard', 'seedance_2'] as const) {
      const model = getVideoModel(modelId)!;
      const w = computeWordCountRangePerSegment(model);
      expect(w.min).toBeLessThan(w.max);
    }
  });
});

describe('Polish-20: clampPerCallSeconds', () => {
  const s15pro = getVideoModel('seedance_1_5_pro')!;
  const kling = getVideoModel('kling_3_standard')!;
  const s2 = getVideoModel('seedance_2')!;

  it('Seedance 1.5 Pro: clamps to [4, 12] and rounds up to even (step 2)', () => {
    expect(clampPerCallSeconds(s15pro, 3)).toBe(4);
    expect(clampPerCallSeconds(s15pro, 4)).toBe(4);
    expect(clampPerCallSeconds(s15pro, 5)).toBe(6); // odd → round up
    expect(clampPerCallSeconds(s15pro, 7)).toBe(8);
    expect(clampPerCallSeconds(s15pro, 12)).toBe(12);
    expect(clampPerCallSeconds(s15pro, 15)).toBe(12);
    expect(clampPerCallSeconds(s15pro, 999)).toBe(12);
  });

  it('Kling: accepts full [3, 15] range', () => {
    expect(clampPerCallSeconds(kling, 2)).toBe(3);
    expect(clampPerCallSeconds(kling, 3)).toBe(3);
    expect(clampPerCallSeconds(kling, 7)).toBe(7);
    expect(clampPerCallSeconds(kling, 15)).toBe(15);
    expect(clampPerCallSeconds(kling, 20)).toBe(15);
  });

  it('Seedance 2: accepts [4, 15] range', () => {
    expect(clampPerCallSeconds(s2, 3)).toBe(4);
    expect(clampPerCallSeconds(s2, 4)).toBe(4);
    expect(clampPerCallSeconds(s2, 9)).toBe(9);
    expect(clampPerCallSeconds(s2, 15)).toBe(15);
    expect(clampPerCallSeconds(s2, 20)).toBe(15);
  });
});

describe('Polish-20: extractSourceScriptVerbatim (Polish-19.4.2 helper)', () => {
  it('returns metadata.analysis.script_transcription when present', () => {
    expect(
      extractSourceScriptVerbatim({
        analysis: {
          script_transcription: 'I swear to god, this $12 drugstore toner is INSANE.',
        },
      }),
    ).toContain('$12');
  });

  it('returns empty string when metadata is null / analysis absent / non-string', () => {
    expect(extractSourceScriptVerbatim(null)).toBe('');
    expect(extractSourceScriptVerbatim({})).toBe('');
    expect(extractSourceScriptVerbatim({ analysis: null })).toBe('');
    expect(extractSourceScriptVerbatim({ analysis: { script_transcription: 42 } })).toBe('');
  });
});

describe('Polish-20: parseVideoAdSpec + fallbackToSingleSegment', () => {
  it('parses a bare JSON segments[] response', () => {
    const raw = JSON.stringify({
      segments: [
        { index: 0, prompt: "She says: 'hi'" },
        { index: 1, prompt: "She continues: '...'" },
      ],
    });
    const r = parseVideoAdSpec(raw);
    expect(r?.segments).toHaveLength(2);
  });

  it('carries sound_texture through when Claude emits it', () => {
    const raw = JSON.stringify({
      segments: [
        {
          index: 0,
          prompt: 'p',
          sound_texture: 'Close-mic iPhone front-camera compression, faint room tone.',
        },
      ],
    });
    const r = parseVideoAdSpec(raw);
    expect(r?.segments[0]?.sound_texture).toContain('Close-mic');
  });

  it('parser stays tolerant to missing sound_texture (back-compat)', () => {
    const raw = JSON.stringify({ segments: [{ index: 0, prompt: 'p' }] });
    const r = parseVideoAdSpec(raw);
    expect(r).not.toBeNull();
    expect(r?.segments[0]?.sound_texture).toBeUndefined();
  });

  it('returns null on empty / malformed input', () => {
    expect(parseVideoAdSpec(null)).toBeNull();
    expect(parseVideoAdSpec('')).toBeNull();
    expect(parseVideoAdSpec('not json')).toBeNull();
    expect(parseVideoAdSpec(JSON.stringify({ segments: [] }))).toBeNull();
    expect(parseVideoAdSpec(JSON.stringify({ segments: [{ index: 0 }] }))).toBeNull();
  });

  it('parses fenced ```json blocks (Claude habit)', () => {
    const inner = JSON.stringify({ segments: [{ prompt: 'p' }] });
    const fenced = '```json\n' + inner + '\n```';
    expect(parseVideoAdSpec(fenced)?.segments).toHaveLength(1);
  });

  it('fallbackToSingleSegment wraps plain text as segments[0]', () => {
    const fb = fallbackToSingleSegment('plain text ad copy');
    expect(fb.segments).toHaveLength(1);
    expect(fb.segments[0]!.prompt).toBe('plain text ad copy');
  });
});

describe('Polish-20 Commit 2: worker dispatch + fan-out source-shape tripwires', () => {
  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('worker listens on generation/video-variant.requested', async () => {
    const src = await readSrc();
    expect(src).toMatch(/event: 'generation\/video-variant\.requested'/);
  });

  it('worker reads model_id + provider_id from job.metadata (not columns)', async () => {
    const src = await readSrc();
    expect(src).toMatch(/jobMetadata\['model_id'\]/);
    expect(src).toMatch(/jobMetadata\['provider_id'\]/);
    // Fails fast when metadata is missing the routing signals.
    expect(src).toMatch(/Missing model_id\/provider_id/);
  });

  it('worker fans segments[] out in parallel via Promise.all + runOneSegment', async () => {
    const src = await readSrc();
    expect(src).toMatch(/Promise\.all\(\s*adSpec\.segments\.map/);
    expect(src).toMatch(/runOneSegment\(/);
    // Tripwire — must NOT regress to a sequential for-loop.
    expect(src).not.toMatch(/for\s*\(const\s+seg\s+of\s+adSpec\.segments\)/);
  });

  it('worker calls runStitch only when successSegments > 1', async () => {
    const src = await readSrc();
    expect(src).toMatch(/if \(successSegments\.length > 1\) \{[\s\S]*?runStitch/);
  });

  it('multi-segment guard fails fast when REPLICATE_VIDEO_CONCAT_MODEL_ID is unset', async () => {
    const src = await readSrc();
    expect(src).toMatch(/autoDuration\.segmentCount > 1 && !isVideoConcatEnabled\(\)/);
    expect(src).toMatch(/REPLICATE_VIDEO_CONCAT_MODEL_ID/);
  });

  it('per-segment rows use isClipPart=true + composite uses isClipPart=false', async () => {
    const src = await readSrc();
    expect(src).toMatch(/isClipPart: true/);
    expect(src).toMatch(/isClipPart: false/);
    expect(src).toMatch(/segment_count_generated: successSegments\.length/);
  });

  it('worker uses config-driven submitKieVideo (not per-model client switch)', async () => {
    const src = await readSrc();
    expect(src).toMatch(/submitKieVideo\(/);
    expect(src).toMatch(/pollKieVideo\(/);
    // Descriptor is passed through, not switched on:
    expect(src).toMatch(/config,\s*prompt/);
  });

  it('runClaudeAdSpec uses per-model word-count calibration + source_script_verbatim + speaker attribution', async () => {
    const src = await readSrc();
    // Polish-19.4.2 pattern carried forward:
    expect(src).toMatch(/computeWordCountRangePerSegment\(model\)/);
    expect(src).toMatch(/source_script_verbatim: sourceScriptVerbatim/);
    expect(src).toMatch(/Speaker attribution/);
    expect(src).toMatch(/PRESERVE:/);
    expect(src).toMatch(/sound_texture/);
  });
});

describe('Polish-20 Commit 2: analyze-concept dispatch route on model_id', () => {
  it('dispatches to generation/video-variant.requested when metadata.model_id is set', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/analyze-concept.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/generation\/video-variant\.requested/);
    expect(src).toMatch(/model_id/);
    // Loud dispatch log fired for the new route:
    expect(src).toMatch(/Polish-20 unified worker/);
  });
});

describe('Polish-20 Commit 5: mock-mode regression pins', () => {
  // The mock branch of generate-video-variant is what /admin's mock
  // toggle exercises — verifying the plumbing before real spend.
  // These tripwires assert the mock path (a) writes rows that match
  // the live path's shape, and (b) exercises every model in the
  // launch matrix identically.

  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('mock branch fires on mode==="mock" BEFORE the live segment fan-out', async () => {
    const src = await readSrc();
    // The mock branch returns early with mode=mock; live fan-out only
    // runs on mode=live. A regression that let mock fall through to
    // the live path would spend real money on kie.ai.
    const mockIdx = src.indexOf("if (mode === 'mock')");
    const fanoutIdx = src.indexOf('Array.from({ length: variantCount }');
    expect(mockIdx).toBeGreaterThan(-1);
    expect(fanoutIdx).toBeGreaterThan(-1);
    expect(mockIdx).toBeLessThan(fanoutIdx);
  });

  it('mock composite row carries model_id + provider_id + segment_count metadata', async () => {
    const src = await readSrc();
    // Every mock composite row must include the routing signals so
    // /runs/[id] can distinguish variants per model without a DB
    // schema change. Tripwire against a regression that dropped one
    // of the descriptor fields.
    expect(src).toMatch(/mock: true/);
    expect(src).toMatch(/model_id: modelId/);
    expect(src).toMatch(/provider_id: providerId/);
    expect(src).toMatch(/segment_count: autoDuration\.segmentCount/);
  });

  it('mock multi-segment path writes per-segment rows (isClipPart: true) + composite (isClipPart: false)', async () => {
    const src = await readSrc();
    // Multi-segment mocks match the live shape so the review grid
    // filters (`isClipPart = false`) work identically in both modes.
    expect(src).toMatch(/if \(autoDuration\.segmentCount > 1\)/);
    expect(src).toMatch(/format: `video_\$\{modelId\}_segment`/);
    expect(src).toMatch(/isClipPart: true/);
    expect(src).toMatch(/isClipPart: false/);
    // Composite row's stitched flag mirrors segmentCount > 1
    expect(src).toMatch(/stitched: autoDuration\.segmentCount > 1/);
  });

  it('mock 8s Seedance 1.5 Pro produces 1 segment (no per-segment rows)', () => {
    // Segment count math is the shared descriptor's job — this test
    // pins the math the mock branch relies on. Seedance 1.5 Pro's
    // 12s cap means 8s target → 1 segment → composite only, no
    // per-segment rows.
    const s15pro = getVideoModel('seedance_1_5_pro')!;
    const r = resolveAutoVideoDuration({ source_duration_seconds: 8 }, s15pro);
    expect(r.segmentCount).toBe(1);
    expect(r.targetSeconds).toBe(8);
  });

  it('mock 60s Seedance 1.5 Pro produces 5 segments (12s × 5) — user-spec regression', () => {
    // From the Polish-20 Commit 5 spec: "60s Seedance 1.5 Pro variant
    // → verify segmentCount = 5 (60 / 12)". Pin the math so a future
    // model-cap change (12s → 10s, say) surfaces this as a failing
    // test before it ships surprise per-variant cost.
    const s15pro = getVideoModel('seedance_1_5_pro')!;
    const r = resolveAutoVideoDuration({ source_duration_seconds: 60 }, s15pro);
    expect(r.segmentCount).toBe(5);
    expect(r.targetSeconds).toBe(60);
  });

  it('mock 60s Kling 3.0 Standard produces 4 segments (15s × 4)', () => {
    const kling = getVideoModel('kling_3_standard')!;
    const r = resolveAutoVideoDuration({ source_duration_seconds: 60 }, kling);
    expect(r.segmentCount).toBe(4);
    expect(r.targetSeconds).toBe(60);
  });

  it('mock 60s Seedance 2 produces 4 segments (15s × 4)', () => {
    const s2 = getVideoModel('seedance_2')!;
    const r = resolveAutoVideoDuration({ source_duration_seconds: 60 }, s2);
    expect(r.segmentCount).toBe(4);
    expect(r.targetSeconds).toBe(60);
  });

  it('mock branch marks the job completed with provider="kie_ai" + path="video-variant"', async () => {
    const src = await readSrc();
    // Mock completions must use the same telemetry path label as the
    // live worker so the admin dashboard's per-worker rollups
    // aggregate correctly across mock and live jobs.
    expect(src).toMatch(
      /mode,\s*startedAt,\s*variantCount,\s*actualCostUsd: 0,\s*provider: 'kie_ai',\s*path: 'video-variant'/,
    );
  });
});

describe('Polish-20 Commit 5: three-model happy-path config lookup', () => {
  // The unified worker's `getModelProviderConfig(modelId, providerId)`
  // is the only routing decision on the hot path. Pin that every
  // launch model resolves to a live kie.ai config with the exact
  // fields the kie-video client will read.
  it('resolves ModelProviderConfig for every launch model', async () => {
    const { getModelProviderConfig } = await import('@mbb/shared');
    for (const modelId of ['seedance_1_5_pro', 'kling_3_standard', 'seedance_2'] as const) {
      const config = getModelProviderConfig(modelId, 'kie_ai');
      expect(config, `no config for ${modelId} × kie_ai`).toBeDefined();
      expect(config!.endpointUrl).toBe('https://api.kie.ai/api/v1/jobs/createTask');
      expect(config!.usdPerSecond).toBeGreaterThan(0);
      expect(config!.modelParam.length).toBeGreaterThan(0);
      // inputShape fields the kie-video client requires.
      expect(config!.inputShape.promptField).toBe('prompt');
      expect(config!.inputShape.durationField).toBe('duration');
      expect(config!.inputShape.aspectRatioField).toBe('aspect_ratio');
      expect(['number', 'string']).toContain(config!.inputShape.durationFormat);
    }
  });

  it('every launch model targets the kie.ai createTask endpoint (Polish-20 launch provider)', async () => {
    const { VIDEO_MODELS, getModelProviderConfig } = await import('@mbb/shared');
    for (const model of VIDEO_MODELS) {
      const config = getModelProviderConfig(model.id, 'kie_ai');
      expect(config).toBeDefined();
      expect(config!.providerId).toBe('kie_ai');
    }
  });
});
