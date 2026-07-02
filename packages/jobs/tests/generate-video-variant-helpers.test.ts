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
  sanitizeSourceAnalysisForClaude,
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

  it('mock branch marks the job completed with provider=<providerId> + path="video-variant"', async () => {
    const src = await readSrc();
    // Polish-21 Commit 2: provider tag derives from job.metadata's
    // routing key so mock jobs on Hedra tag as `hedra`, kie.ai jobs
    // as `kie_ai`, and future providers slot in without a code
    // change. Path label stays constant so admin per-worker rollups
    // aggregate correctly across mock and live jobs regardless of
    // provider.
    expect(src).toMatch(
      /mode,\s*startedAt,\s*variantCount,\s*actualCostUsd: 0,\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*provider: providerId,\s*path: 'video-variant'/,
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

  it('every legacy launch model targets the kie.ai createTask endpoint (Polish-20 provider)', async () => {
    // Polish-21: Hedra Character 3 is launcher-visible and routes to
    // the Hedra provider; the seedance/kling entries stay hidden
    // (hiddenFromLauncher: true) and retain their kie.ai configs
    // through Commit 3. Scope this pin to the still-hidden legacy
    // slice so it survives the Polish-21 transition.
    const { VIDEO_MODELS, getModelProviderConfig } = await import('@mbb/shared');
    const legacyModels = VIDEO_MODELS.filter((m) => m.hiddenFromLauncher);
    expect(legacyModels.length).toBeGreaterThan(0);
    for (const model of legacyModels) {
      const config = getModelProviderConfig(model.id, 'kie_ai');
      expect(config).toBeDefined();
      expect(config!.providerId).toBe('kie_ai');
    }
  });
});

describe('Polish-20.0.2 hotfix: extractMetadataObject', () => {
  // Defensive metadata shape handling — postgres-js normally returns
  // jsonb as parsed objects, but this helper handles the edge case
  // where the value comes back as a JSON string. The pre-20.0.2
  // dispatch bug on job 84fee5b7 was consistent with either a stale
  // deploy OR a driver-edge-case where jsonb came back as string;
  // the extractor closes both classes of failure.

  it('passes through a plain object', async () => {
    const { extractMetadataObject } = await import('../src/functions/analyze-concept');
    const input = { model_id: 'seedance_1_5_pro', provider_id: 'kie_ai' };
    expect(extractMetadataObject(input)).toEqual(input);
  });

  it('parses a JSON string (postgres-js driver edge case)', async () => {
    const { extractMetadataObject } = await import('../src/functions/analyze-concept');
    const raw = '{"model_id":"seedance_1_5_pro","provider_id":"kie_ai"}';
    const r = extractMetadataObject(raw);
    expect(r).not.toBeNull();
    expect(r?.model_id).toBe('seedance_1_5_pro');
    expect(r?.provider_id).toBe('kie_ai');
  });

  it('returns null for null / undefined', async () => {
    const { extractMetadataObject } = await import('../src/functions/analyze-concept');
    expect(extractMetadataObject(null)).toBeNull();
    expect(extractMetadataObject(undefined)).toBeNull();
  });

  it('returns null for arrays (defensive — metadata is expected to be an object)', async () => {
    const { extractMetadataObject } = await import('../src/functions/analyze-concept');
    expect(extractMetadataObject([])).toBeNull();
    expect(extractMetadataObject(['seedance_1_5_pro'])).toBeNull();
  });

  it('returns null for a JSON string that parses to a non-object (number / string / array)', async () => {
    const { extractMetadataObject } = await import('../src/functions/analyze-concept');
    expect(extractMetadataObject('42')).toBeNull();
    expect(extractMetadataObject('"just a string"')).toBeNull();
    expect(extractMetadataObject('[1,2,3]')).toBeNull();
  });

  it('returns null for malformed JSON strings (never throws)', async () => {
    const { extractMetadataObject } = await import('../src/functions/analyze-concept');
    expect(extractMetadataObject('not json')).toBeNull();
    expect(extractMetadataObject('{unterminated')).toBeNull();
    expect(extractMetadataObject('')).toBeNull();
  });

  it('returns null for other primitive types (numbers / booleans)', async () => {
    const { extractMetadataObject } = await import('../src/functions/analyze-concept');
    expect(extractMetadataObject(42)).toBeNull();
    expect(extractMetadataObject(true)).toBeNull();
    expect(extractMetadataObject(false)).toBeNull();
  });
});

describe('Polish-20.0.2 hotfix: analyze-concept dispatch precedence tripwires', () => {
  // Source-shape tripwires against the dispatch function. Direct
  // integration tests of loadJobRoutingEvent require spinning up
  // Drizzle + Postgres; these string-shape pins catch the specific
  // regression that hit production on job 84fee5b7 (dispatch fell
  // through to pickedPipeline even though metadata.model_id was set)
  // at CI time.

  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(new URL('../src/functions/analyze-concept.ts', import.meta.url), 'utf8');
  };

  it('metadata.model_id branch appears BEFORE the pickedPipeline branch', async () => {
    const src = await readSrc();
    // Locate the "if (modelIdFromMetadata)" block and the
    // "const pipeline = pipelineFromString" block within
    // loadJobRoutingEvent and pin ordering. A regression that
    // reorders these would drop back to the 20.0.2 production bug.
    const modelIdBranchIdx = src.indexOf('if (modelIdFromMetadata)');
    const pickedPipelineBranchIdx = src.indexOf(
      'const pipeline = pipelineFromString(row?.pickedPipeline)',
    );
    expect(modelIdBranchIdx).toBeGreaterThan(-1);
    expect(pickedPipelineBranchIdx).toBeGreaterThan(-1);
    expect(modelIdBranchIdx).toBeLessThan(pickedPipelineBranchIdx);
  });

  it('metadata.model_id branch returns generation/video-variant.requested', async () => {
    const src = await readSrc();
    expect(src).toMatch(
      /if \(modelIdFromMetadata\)[\s\S]{0,400}return 'generation\/video-variant\.requested'/,
    );
  });

  it('metadata is read via the defensive extractMetadataObject helper (NOT a raw cast)', async () => {
    const src = await readSrc();
    // Regression against reverting to the pre-20.0.2 cast pattern
    // `(row?.metadata ?? null) as Record<string, unknown> | null`
    // which was unsafe against the postgres-js jsonb-as-string edge
    // case.
    expect(src).toMatch(/extractMetadataObject\(row\?\.metadata \?\? null\)/);
  });

  it('dispatch diagnostic log includes metadata shape + keys + model_id + provider_id', async () => {
    const src = await readSrc();
    // The Polish-20.0.2 verbose dispatch log is the operator's
    // primary tool for diagnosing future misdispatches. Pin every
    // field it needs to surface.
    expect(src).toMatch(/dispatch inputs/);
    expect(src).toMatch(/metadata_shape=/);
    expect(src).toMatch(/metadata_keys=/);
    expect(src).toMatch(/metadata\.model_id=/);
    expect(src).toMatch(/metadata\.provider_id=/);
  });

  it('generation/video-variant.requested still routes through the video-variant worker', async () => {
    const fs = await import('node:fs/promises');
    const registrySrc = await fs.readFile(
      new URL('../src/functions/index.ts', import.meta.url),
      'utf8',
    );
    // Both the Set entry AND the worker import must survive so the
    // dispatch we route to is actually listened for. Commit 3's
    // dispatch-coverage cleanup dropped 4 legacy events but the
    // video-variant registration MUST stay.
    expect(registrySrc).toMatch(/'generation\/video-variant\.requested'/);
    expect(registrySrc).toMatch(/generateVideoVariant/);
  });
});

describe('Polish-20.0.3: sanitizeSourceAnalysisForClaude', () => {
  it('returns ONLY the vision-derived analysis object (strips draft_prompt / model_id / _live)', () => {
    const jobMetadata = {
      analysis: {
        script_transcription: 'I swear to god...',
        subject: { appearance: 'woman in car' },
        video_duration_seconds: 24,
      },
      draft_prompt: '**Character:** David. **Camera Shot:** Medium.',
      model_id: 'seedance_1_5_pro',
      provider_id: 'kie_ai',
      _live: true,
      analyzed_at: '2026-01-01T00:00:00Z',
      source_duration_seconds: 24,
    };
    const r = sanitizeSourceAnalysisForClaude(jobMetadata);
    // Vision fields SURVIVE:
    expect(r.script_transcription).toBe('I swear to god...');
    expect(r.subject).toEqual({ appearance: 'woman in car' });
    expect(r.video_duration_seconds).toBe(24);
    // Sora-era + routing fields ARE stripped — this is the exact
    // regression that caused Claude to copy bracketed prose on
    // job 395cc9b7.
    expect(r.draft_prompt).toBeUndefined();
    expect(r.model_id).toBeUndefined();
    expect(r.provider_id).toBeUndefined();
    expect(r._live).toBeUndefined();
    expect(r.analyzed_at).toBeUndefined();
    expect(r.source_duration_seconds).toBeUndefined();
  });

  it('returns empty object for null / missing analysis (Claude gets no context, not stale context)', () => {
    expect(sanitizeSourceAnalysisForClaude(null)).toEqual({});
    expect(sanitizeSourceAnalysisForClaude({})).toEqual({});
    expect(sanitizeSourceAnalysisForClaude({ analysis: null })).toEqual({});
    expect(sanitizeSourceAnalysisForClaude({ analysis: 'string-not-object' })).toEqual({});
    expect(sanitizeSourceAnalysisForClaude({ analysis: [1, 2] })).toEqual({});
  });

  it('returns a defensive copy (mutation does not leak back to caller state)', () => {
    const inner = { script_transcription: 'x' };
    const r = sanitizeSourceAnalysisForClaude({ analysis: inner });
    (r as { added?: boolean }).added = true;
    expect(inner).not.toHaveProperty('added');
  });
});

describe('Polish-20.0.3: runClaudeAdSpec system-prompt regression tripwires', () => {
  // The Polish-20.0.3 hotfix rewrote runClaudeAdSpec's system prompt
  // to (a) hard-reject bracketed section styling ("**Character:**"
  // etc.) and (b) anchor Claude to a yapper-style worked example.
  // These tripwires pin those changes so a future prompt cleanup
  // can't drop them without failing CI.

  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('system prompt explicitly rejects bracketed section style ("**Camera Shot:**", etc.)', async () => {
    const src = await readSrc();
    expect(src).toMatch(/NO bracketed sections/);
    expect(src).toMatch(/\*\*Camera Shot:\*\*/);
    expect(src).toMatch(/\*\*Actions:\*\*/);
    expect(src).toMatch(/\*\*Dialogue:\*\*/);
    expect(src).toMatch(/IGNORE that structure/);
  });

  it('system prompt anchors Claude on a yapper-style worked example (not bracketed sections)', async () => {
    const src = await readSrc();
    // The 20.0.3 worked example uses "I swear to god" + "$80" + "NOTHING"
    // in flowing prose to anchor Claude on the target style. Pin the
    // markers so a future rewrite either keeps this shape or ships a
    // new anchor with a new test.
    expect(src).toMatch(/WORKED EXAMPLE/);
    expect(src).toMatch(/yapper-style prose/);
    expect(src).toMatch(/I swear to god/);
    expect(src).toMatch(/\$80/);
    expect(src).toMatch(/NOTHING/);
  });

  it('worker calls runClaudeAdSpec BEFORE any submitKieVideo call (not draft_prompt passthrough)', async () => {
    const src = await readSrc();
    // Layout regression: the Claude ad-spec step must be the first
    // substantive step of every variant, generating segments[] used
    // by the fan-out. A regression that skipped Claude (or that
    // passed draft_prompt straight to Seedance) would fail this
    // ordering check.
    //
    // Look for the CALL sites (not the identifier — the definition
    // appears later in the file). `runClaudeAdSpec({` matches the
    // invocation; `submitKieVideo({` matches the segment submit.
    const claudeCallIdx = src.indexOf('runClaudeAdSpec({');
    const submitCallIdx = src.indexOf('submitKieVideo({');
    expect(claudeCallIdx).toBeGreaterThan(-1);
    expect(submitCallIdx).toBeGreaterThan(-1);
    expect(claudeCallIdx).toBeLessThan(submitCallIdx);
  });

  it('userMessage passes SANITIZED source_analysis (not jobMetadata directly)', async () => {
    const src = await readSrc();
    // Regression against passing `source_analysis: jobMetadata ?? {}`
    // which was the exact bug on job 395cc9b7 — Claude saw draft_prompt
    // and copied bracketed styling.
    expect(src).toMatch(/source_analysis: sanitizedSourceAnalysis/);
    expect(src).toMatch(/sanitizeSourceAnalysisForClaude\(jobMetadata\)/);
  });

  it('userMessage still passes source_script_verbatim at the top level (PRESERVE rules)', async () => {
    const src = await readSrc();
    // The Polish-19.4.2 source-script-verbatim preservation still
    // fires — the sanitize step trimmed the analysis dict, not the
    // top-level verbatim script.
    expect(src).toMatch(/source_script_verbatim: sourceScriptVerbatim/);
    expect(src).toMatch(/extractSourceScriptVerbatim\(jobMetadata\)/);
  });
});

describe('Polish-20.0.3: extractInnerVisionAnalysis', () => {
  it('unwraps Gemini shape { analysis: {...}, draft_prompt: "..." } → inner analysis object', async () => {
    const { extractInnerVisionAnalysis } = await import('../src/functions/analyze-concept');
    const gemini = {
      analysis: {
        script_transcription: 'yap yap',
        video_duration_seconds: 24,
        subject: { appearance: 'x' },
      },
      draft_prompt: '**Character:** David. **Camera Shot:** Medium.',
    };
    const r = extractInnerVisionAnalysis(gemini);
    expect(r.script_transcription).toBe('yap yap');
    expect(r.video_duration_seconds).toBe(24);
    expect(r).not.toHaveProperty('draft_prompt');
  });

  it('handles a legacy flat shape (no inner .analysis wrapper) — strips draft_prompt but keeps peer fields', async () => {
    const { extractInnerVisionAnalysis } = await import('../src/functions/analyze-concept');
    const flat = {
      script_transcription: 'legacy shape',
      draft_prompt: 'should be stripped',
      video_duration_seconds: 12,
    };
    const r = extractInnerVisionAnalysis(flat);
    expect(r.script_transcription).toBe('legacy shape');
    expect(r.video_duration_seconds).toBe(12);
    expect(r).not.toHaveProperty('draft_prompt');
  });

  it('handles null / undefined / non-object inputs defensively', async () => {
    const { extractInnerVisionAnalysis } = await import('../src/functions/analyze-concept');
    expect(extractInnerVisionAnalysis(null)).toEqual({});
    expect(extractInnerVisionAnalysis(undefined)).toEqual({});
    // TypeScript would reject these but the runtime should still
    // return safely.
    expect(extractInnerVisionAnalysis('string' as unknown as Record<string, unknown>)).toEqual({});
  });
});

describe('Polish-20.0.3: analyze-concept store-analysis nesting fix', () => {
  it('store-analysis uses extractInnerVisionAnalysis (fixes metadata.analysis.analysis double-nesting)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/analyze-concept.ts', import.meta.url),
      'utf8',
    );
    // Regression against writing `analysis: visionResult.analysis`
    // directly — that produced metadata.analysis.analysis.subject
    // and leaked draft_prompt into the worker's Claude context on
    // job 395cc9b7. The 20.0.3 fix extracts the inner analysis
    // object before the merge; pin both call sites.
    expect(src).toMatch(
      /const innerAnalysis = extractInnerVisionAnalysis\(visionResult\.analysis\)/,
    );
    expect(src).toMatch(/analysis: innerAnalysis/);
    // Guard against the exact pre-20.0.3 pattern regressing.
    expect(src).not.toMatch(/analysis: visionResult\.analysis,\s*_live/);
  });
});

describe('Polish-20.0.3: Gemini Vision schema requests video_duration_seconds', () => {
  it('UGC_DECONSTRUCTOR_SYSTEM_PROMPT schema block includes video_duration_seconds', async () => {
    const { UGC_DECONSTRUCTOR_SYSTEM_PROMPT } = await import('@mbb/shared');
    // Pre-20.0.3 the schema omitted video_duration_seconds so
    // Gemini never returned it and the worker's fallback chain
    // dropped to the 30s default. Regression against dropping it
    // again during a future schema tighten.
    expect(UGC_DECONSTRUCTOR_SYSTEM_PROMPT).toMatch(/video_duration_seconds/);
    expect(UGC_DECONSTRUCTOR_SYSTEM_PROMPT).toMatch(/video_duration_seconds requirement/);
  });
});

// =====================================================================
// Polish-21 Commit 2: Hedra branch dispatch + Claude prompt + parser
// =====================================================================

describe('Polish-21 Commit 2: parseVideoAdSpecHedra', () => {
  it('accepts nested {scene: {scene_description, script}}', async () => {
    const { parseVideoAdSpecHedra } = await import('../src/functions/generate-video-variant');
    const raw = JSON.stringify({
      scene: {
        scene_description: 'A 34-year-old woman in a parked SUV, tripod-style selfie framing.',
        script: 'I swear to god, I was spending $80 a month on face serums.',
      },
    });
    const r = parseVideoAdSpecHedra(raw);
    expect(r).not.toBeNull();
    expect(r!.scene.script).toMatch(/\$80/);
    expect(r!.scene.scene_description).toMatch(/tripod-style/);
  });

  it('accepts a flat {scene_description, script} shape too (defensive fallback)', async () => {
    const { parseVideoAdSpecHedra } = await import('../src/functions/generate-video-variant');
    const raw = JSON.stringify({
      scene_description: 'Kitchen selfie, morning light.',
      script: 'You will NOT believe this hack.',
    });
    const r = parseVideoAdSpecHedra(raw);
    expect(r).not.toBeNull();
    expect(r!.scene.scene_description).toMatch(/Kitchen/);
    expect(r!.scene.script).toMatch(/NOT believe/);
  });

  it('unwraps ```json fences', async () => {
    const { parseVideoAdSpecHedra } = await import('../src/functions/generate-video-variant');
    const raw = '```json\n{"scene":{"scene_description":"a","script":"b"}}\n```';
    const r = parseVideoAdSpecHedra(raw);
    expect(r).not.toBeNull();
    expect(r!.scene.scene_description).toBe('a');
  });

  it('rejects empty scene_description or missing script', async () => {
    const { parseVideoAdSpecHedra } = await import('../src/functions/generate-video-variant');
    expect(parseVideoAdSpecHedra('{"scene":{"scene_description":"","script":"x"}}')).toBeNull();
    expect(parseVideoAdSpecHedra('{"scene":{"scene_description":"x"}}')).toBeNull();
    expect(parseVideoAdSpecHedra('not json')).toBeNull();
  });

  it('recovers when JSON is preceded/followed by prose (worst-case Claude output)', async () => {
    const { parseVideoAdSpecHedra } = await import('../src/functions/generate-video-variant');
    const raw =
      'Here is the scene:\n{"scene":{"scene_description":"kitchen","script":"hi"}}\nThanks!';
    const r = parseVideoAdSpecHedra(raw);
    expect(r).not.toBeNull();
    expect(r!.scene.script).toBe('hi');
  });
});

describe('Polish-21 Commit 2: pickHedraVoiceForVariant (worker helper)', () => {
  it('returns a valid roster entry for every variant in a 5-batch', async () => {
    const { pickHedraVoiceForVariant } = await import('../src/functions/generate-video-variant');
    const jobId = 'job-abc-xyz-42';
    const picks = Array.from({ length: 5 }, (_, i) =>
      pickHedraVoiceForVariant({ variantIndex: i, variantCount: 5, jobId }),
    );
    expect(picks).toHaveLength(5);
    for (const v of picks) {
      expect(v.id.length).toBeGreaterThan(0);
      expect(['female', 'male']).toContain(v.gender);
    }
    // 5 unique voices out of the 6-slot roster.
    expect(new Set(picks.map((v) => v.id)).size).toBe(5);
  });

  it('same jobId + variantCount + variantIndex returns identical voice (Inngest retry safe)', async () => {
    const { pickHedraVoiceForVariant } = await import('../src/functions/generate-video-variant');
    const a = pickHedraVoiceForVariant({ variantIndex: 2, variantCount: 5, jobId: 'j-1' });
    const b = pickHedraVoiceForVariant({ variantIndex: 2, variantCount: 5, jobId: 'j-1' });
    expect(a.id).toBe(b.id);
  });

  it('different jobIds land different variant-0 voices (batch-level diversity)', async () => {
    const { pickHedraVoiceForVariant } = await import('../src/functions/generate-video-variant');
    const ids = ['j-a', 'j-b', 'j-c', 'j-d', 'j-e', 'j-f'];
    const first = ids.map(
      (jobId) => pickHedraVoiceForVariant({ variantIndex: 0, variantCount: 5, jobId }).id,
    );
    expect(new Set(first).size).toBeGreaterThanOrEqual(2);
  });
});

describe('Polish-21 Commit 2: worker dispatch tripwires', () => {
  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('runOneVariant dispatches to runOneVariantHedra when model.id === "hedra_character_3"', async () => {
    const src = await readSrc();
    // Layout regression: the Hedra branch must be the FIRST decision
    // in runOneVariant. Without it, the kie.ai fan-out runs on Hedra
    // jobs and crashes on getKieVideoUsdPerSecond / submitKieVideo.
    expect(src).toMatch(
      /async function runOneVariant\(input: RunOneVariantInput\): Promise<VideoVariantResult> \{[\s\S]*?if \(input\.model\.id === 'hedra_character_3'\) \{[\s\S]*?return runOneVariantHedra\(input\);/,
    );
  });

  it('runOneVariantHedra is defined and calls Claude → Nano Banana → asset → submit → poll → download → insert in that order', async () => {
    const src = await readSrc();
    // Pin the 9-step Polish-21 Commit 2 flow via step.run identifier
    // ordering. Regressions that skip Nano Banana or run the poll
    // before submit will fail this ordering check.
    const orderedStepLabels = [
      'hedra-claude-',
      'hedra-nano-banana-',
      'hedra-image-asset-',
      'hedra-submit-',
      'hedra-poll-',
      'hedra-upload-video-',
      'hedra-insert-composite-',
    ];
    let lastIdx = -1;
    for (const label of orderedStepLabels) {
      const idx = src.indexOf(label);
      expect(idx, `step ${label} missing`).toBeGreaterThan(-1);
      expect(idx, `step ${label} out of order`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('runOneVariantHedra checks isHedraVoiceRosterUncurated FIRST (fail-fast before spending)', async () => {
    const src = await readSrc();
    // Roster gate must run before any paid API call so an empty
    // roster doesn't burn Claude/Nano Banana credits before erroring.
    const rosterGateIdx = src.indexOf('isHedraVoiceRosterUncurated()');
    const claudeIdx = src.indexOf('hedra-claude-');
    expect(rosterGateIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(rosterGateIdx).toBeLessThan(claudeIdx);
  });

  it('runOneVariantHedra loads the hedra BYOK key (not kie_ai)', async () => {
    const src = await readSrc();
    // Regression against copy-paste from the kie.ai branch — the
    // Hedra flow must call loadDecryptedKeys(..., ['hedra']) at each
    // step boundary (fresh decrypt per step keeps plaintext short-
    // lived, matches the Polish-3 chokepoint rationale).
    const runOneVariantHedraStart = src.indexOf('async function runOneVariantHedra');
    const runOneVariantHedraEnd = src.indexOf('export function pickHedraVoiceForVariant');
    expect(runOneVariantHedraStart).toBeGreaterThan(-1);
    expect(runOneVariantHedraEnd).toBeGreaterThan(runOneVariantHedraStart);
    const hedraFn = src.slice(runOneVariantHedraStart, runOneVariantHedraEnd);
    expect(hedraFn).toMatch(/loadDecryptedKeys\(userId, \['hedra'\]\)/);
    // Nano Banana still uses gemini — that's expected.
    expect(hedraFn).toMatch(/loadDecryptedKeys\(userId, \['gemini'\]\)/);
    // NO kie_ai lookups in the Hedra branch.
    expect(hedraFn).not.toMatch(/loadDecryptedKeys\(userId, \['kie_ai'\]\)/);
  });

  it('Hedra submit uses tts { voiceId, text } (name in voiceId field, not audio_id)', async () => {
    const src = await readSrc();
    // Polish-21 Commit 2 ships native TTS (roster voice NAME in the
    // voice_id field). Uploaded-audio mode is exposed on the client
    // but the worker doesn't use it at launch. Regression pin: an
    // accidental audio_id path would silently swap voices.
    const runOneVariantHedraStart = src.indexOf('async function runOneVariantHedra');
    const runOneVariantHedraEnd = src.indexOf('export function pickHedraVoiceForVariant');
    const hedraFn = src.slice(runOneVariantHedraStart, runOneVariantHedraEnd);
    expect(hedraFn).toMatch(/tts: \{ voiceId: voice\.id, text: script \}/);
    expect(hedraFn).not.toMatch(/audioAssetId:/);
  });

  it('Hedra composite row carries voice + generation metadata for forensics', async () => {
    const src = await readSrc();
    // Every field we log to generationMetadata is what the run-
    // detail page renders and what we grep for in production
    // diagnostics. Pin them so a future rewrite doesn't silently
    // drop forensic surface.
    const runOneVariantHedraStart = src.indexOf('async function runOneVariantHedra');
    const runOneVariantHedraEnd = src.indexOf('export function pickHedraVoiceForVariant');
    const hedraFn = src.slice(runOneVariantHedraStart, runOneVariantHedraEnd);
    expect(hedraFn).toMatch(/hedra_generation_id: generationId/);
    expect(hedraFn).toMatch(/hedra_input_asset_id: startKeyframeId/);
    expect(hedraFn).toMatch(/voice_id: voice\.id/);
    expect(hedraFn).toMatch(/voice_gender: voice\.gender/);
    expect(hedraFn).toMatch(/text_prompt: sceneDescription/);
    expect(hedraFn).toMatch(/script,/);
  });
});

describe('Polish-21 Commit 2: runClaudeAdSpecHedra system prompt', () => {
  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('asks for scenes[] shape NOT segments[] — Character 3 is single-call', async () => {
    const src = await readSrc();
    // Pin the schema anchor. A regression that reused Polish-20's
    // segments[] structure for Hedra would generate multi-scene
    // output the single-call Hedra flow can't consume.
    const hedraPromptStart = src.indexOf('async function runClaudeAdSpecHedra');
    const hedraPromptEnd = src.indexOf('// ---', hedraPromptStart);
    expect(hedraPromptStart).toBeGreaterThan(-1);
    const hedraPromptFn = src.slice(hedraPromptStart, hedraPromptEnd);
    expect(hedraPromptFn).toMatch(/"scene"/);
    expect(hedraPromptFn).toMatch(/"scene_description"/);
    expect(hedraPromptFn).toMatch(/"script"/);
    expect(hedraPromptFn).not.toMatch(/"segments"/);
  });

  it('drops sound_texture (Hedra handles audio via native TTS)', async () => {
    const src = await readSrc();
    // Character 3 generates audio from TTS on the roster voice. The
    // Polish-20.0.3 sound_texture field is meaningless here — pin
    // that it does NOT appear in the Hedra prompt schema.
    const hedraPromptStart = src.indexOf('async function runClaudeAdSpecHedra');
    const hedraPromptEnd = src.indexOf('// ---', hedraPromptStart);
    const hedraPromptFn = src.slice(hedraPromptStart, hedraPromptEnd);
    expect(hedraPromptFn).not.toMatch(/sound_texture/);
  });

  it('drops speaker-attribution boilerplate ("She says:" / "He confesses:") — script IS the speech', async () => {
    const src = await readSrc();
    // Character 3's audio is the script text sent to TTS. If Claude
    // emits stage directions like "She says: '...'" the TTS voice
    // will literally read "She says" aloud.
    const hedraPromptStart = src.indexOf('async function runClaudeAdSpecHedra');
    const hedraPromptEnd = src.indexOf('// ---', hedraPromptStart);
    const hedraPromptFn = src.slice(hedraPromptStart, hedraPromptEnd);
    expect(hedraPromptFn).toMatch(/NO stage directions, NO speaker attribution/);
  });

  it('specifies 50-80 word scene descriptions (not the Polish-20 300-word yapper)', async () => {
    const src = await readSrc();
    const hedraPromptStart = src.indexOf('async function runClaudeAdSpecHedra');
    const hedraPromptEnd = src.indexOf('// ---', hedraPromptStart);
    const hedraPromptFn = src.slice(hedraPromptStart, hedraPromptEnd);
    expect(hedraPromptFn).toMatch(/50-80 words/);
  });

  it('KEEPS Polish-19.4.2 verbatim source-script preservation rule', async () => {
    const src = await readSrc();
    // This is the core ad-copy skill Claude adds. Verbatim preservation
    // of hook openers, dollar amounts, ALL CAPS words, filler words,
    // ellipses, product/offer phrases from the source ad.
    const hedraPromptStart = src.indexOf('async function runClaudeAdSpecHedra');
    const hedraPromptEnd = src.indexOf('// ---', hedraPromptStart);
    const hedraPromptFn = src.slice(hedraPromptStart, hedraPromptEnd);
    expect(hedraPromptFn).toMatch(/SOURCE-SCRIPT PRESERVATION/);
    expect(hedraPromptFn).toMatch(/PRESERVE/);
    expect(hedraPromptFn).toMatch(/hook openers/);
    expect(hedraPromptFn).toMatch(/dollar amounts/);
    expect(hedraPromptFn).toMatch(/ALL CAPS emphasis words/);
    expect(hedraPromptFn).toMatch(/source_script_verbatim: sourceScriptVerbatim/);
  });

  it('rejects bracketed Sora-era styling (Polish-20.0.3 anchor still applies to Hedra)', async () => {
    const src = await readSrc();
    // Even though Hedra is a different flow, Claude's tendency to
    // copy bracketed source structure would still leak into
    // scene_description prose. Pin the "IGNORE bracketed style"
    // instruction.
    const hedraPromptStart = src.indexOf('async function runClaudeAdSpecHedra');
    const hedraPromptEnd = src.indexOf('// ---', hedraPromptStart);
    const hedraPromptFn = src.slice(hedraPromptStart, hedraPromptEnd);
    expect(hedraPromptFn).toMatch(/NO bracketed sections/);
    expect(hedraPromptFn).toMatch(/IGNORE it — do NOT copy the structure/);
  });

  it('userMessage includes source_script_verbatim + sanitized source_analysis (not raw jobMetadata)', async () => {
    const src = await readSrc();
    // Same Polish-20.0.3 sanitization discipline as the kie.ai path —
    // Hedra Claude also gets ONLY the vision-derived analysis, never
    // the draft_prompt blob.
    const hedraFnStart = src.indexOf('async function runClaudeAdSpecHedra');
    const hedraFnEnd = src.indexOf('// ---', hedraFnStart);
    const hedraFn = src.slice(hedraFnStart, hedraFnEnd);
    expect(hedraFn).toMatch(/source_script_verbatim: sourceScriptVerbatim/);
    expect(hedraFn).toMatch(/source_analysis: sanitizedSourceAnalysis/);
    expect(hedraFn).toMatch(/sanitizeSourceAnalysisForClaude\(jobMetadata\)/);
  });
});
