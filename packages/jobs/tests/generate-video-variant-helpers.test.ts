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
  validateHedraSpecMinLengths,
  HEDRA_MIN_SCENE_DESCRIPTION_CHARS,
  HEDRA_MIN_SCRIPT_CHARS,
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

describe('Polish-21.0.4: pickElevenLabsVoiceForVariant (worker helper)', () => {
  it('returns 5 distinct roster entries for a 5-batch (Polish-21.0.4 batch diversity restored)', async () => {
    const { pickElevenLabsVoiceForVariant } =
      await import('../src/functions/generate-video-variant');
    const jobId = 'job-abc-xyz-42';
    const picks = Array.from({ length: 5 }, (_, i) =>
      pickElevenLabsVoiceForVariant({ variantIndex: i, variantCount: 5, jobId }),
    );
    expect(picks).toHaveLength(5);
    for (const v of picks) {
      expect(v.id.length).toBeGreaterThan(0);
      expect(['female', 'male']).toContain(v.gender);
    }
    // Polish-21.0.4 restores batch diversity — the 5-preset
    // ElevenLabs roster lands one distinct voice per variant on a
    // 5-batch (single wrap around the whole roster).
    expect(new Set(picks.map((v) => v.id)).size).toBe(5);
  });

  it('same jobId + variantCount + variantIndex returns identical voice (Inngest retry safe)', async () => {
    const { pickElevenLabsVoiceForVariant } =
      await import('../src/functions/generate-video-variant');
    const a = pickElevenLabsVoiceForVariant({ variantIndex: 2, variantCount: 5, jobId: 'j-1' });
    const b = pickElevenLabsVoiceForVariant({ variantIndex: 2, variantCount: 5, jobId: 'j-1' });
    expect(a.id).toBe(b.id);
  });

  it('different jobIds land different variant-0 voices (batch-level diversity across concurrent batches)', async () => {
    const { pickElevenLabsVoiceForVariant } =
      await import('../src/functions/generate-video-variant');
    const ids = ['j-a', 'j-b', 'j-c', 'j-d', 'j-e', 'j-f'];
    const firstPicks = ids.map(
      (jobId) => pickElevenLabsVoiceForVariant({ variantIndex: 0, variantCount: 5, jobId }).id,
    );
    // Regression pin: with a 5-preset roster and offset derived
    // from jobId hash, variant 0 across the fixture jobIds MUST
    // land at least 2 distinct voices (usually more; the ceiling
    // is 5 = roster size).
    expect(new Set(firstPicks).size).toBeGreaterThanOrEqual(2);
  });

  it('legacy pickHedraVoiceForVariant alias still resolves (backward-compat during migration)', async () => {
    const { pickHedraVoiceForVariant, pickElevenLabsVoiceForVariant } =
      await import('../src/functions/generate-video-variant');
    // Polish-21.0.4 renamed pickHedraVoiceForVariant to
    // pickElevenLabsVoiceForVariant. The old name is kept as a
    // deprecated alias so downstream imports don't break during
    // the migration window.
    expect(pickHedraVoiceForVariant).toBe(pickElevenLabsVoiceForVariant);
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
    // Polish-21.0.4 hotfix: 11-step flow now includes ElevenLabs TTS
    // + Hedra audio asset upload. Regressions that skip any step or
    // run TTS after the Hedra submit will fail this ordering check.
    const orderedStepLabels = [
      'hedra-claude-',
      'hedra-nano-banana-',
      'hedra-image-asset-',
      // Polish-21.0.4 added:
      'elevenlabs-tts-',
      'hedra-audio-asset-',
      // /Polish-21.0.4
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

  it('runOneVariantHedra checks isElevenLabsVoiceRosterUncurated FIRST (fail-fast before spending)', async () => {
    const src = await readSrc();
    // Roster gate must run before any paid API call so an empty
    // roster doesn't burn Claude / Nano Banana / ElevenLabs credits
    // before erroring.
    const rosterGateIdx = src.indexOf('isElevenLabsVoiceRosterUncurated()');
    const claudeIdx = src.indexOf('hedra-claude-');
    expect(rosterGateIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(rosterGateIdx).toBeLessThan(claudeIdx);
  });

  it('runOneVariantHedra loads the hedra + elevenlabs + gemini BYOK keys (not kie_ai)', async () => {
    const src = await readSrc();
    // Polish-21.0.4 hotfix: the Hedra flow needs THREE BYOK keys —
    // hedra (video generation + asset upload), elevenlabs (TTS),
    // gemini (Nano Banana Pro reference image). NO kie_ai.
    const runOneVariantHedraStart = src.indexOf('async function runOneVariantHedra');
    const runOneVariantHedraEnd = src.indexOf('export function pickElevenLabsVoiceForVariant');
    expect(runOneVariantHedraStart).toBeGreaterThan(-1);
    expect(runOneVariantHedraEnd).toBeGreaterThan(runOneVariantHedraStart);
    const hedraFn = src.slice(runOneVariantHedraStart, runOneVariantHedraEnd);
    expect(hedraFn).toMatch(/loadDecryptedKeys\(userId, \['hedra'\]\)/);
    expect(hedraFn).toMatch(/loadDecryptedKeys\(userId, \['elevenlabs'\]\)/);
    expect(hedraFn).toMatch(/loadDecryptedKeys\(userId, \['gemini'\]\)/);
    // Regression pin: NO kie_ai lookups.
    expect(hedraFn).not.toMatch(/loadDecryptedKeys\(userId, \['kie_ai'\]\)/);
  });

  it('Hedra submit uses audioAssetId (uploaded ElevenLabs mp3); NO native tts block', async () => {
    const src = await readSrc();
    // Polish-21.0.4 hotfix: Hedra native TTS is gone. The worker
    // uploads ElevenLabs-generated audio as a Hedra audio asset
    // and references it via audio_id. Regression pin: an accidental
    // tts:{voiceId,text} path would 404 on Hedra Creator plans
    // because built-in voice UUIDs aren't accessible.
    const runOneVariantHedraStart = src.indexOf('async function runOneVariantHedra');
    const runOneVariantHedraEnd = src.indexOf('export function pickElevenLabsVoiceForVariant');
    const hedraFn = src.slice(runOneVariantHedraStart, runOneVariantHedraEnd);
    expect(hedraFn).toMatch(/audioAssetId,/);
    // Native TTS shape MUST NOT appear.
    expect(hedraFn).not.toMatch(/tts: \{ voiceId: voice\.id, text: script \}/);
  });

  it('Hedra composite row carries voice + generation metadata for forensics', async () => {
    const src = await readSrc();
    // Every field we log to generationMetadata is what the run-
    // detail page renders and what we grep for in production
    // diagnostics. Pin them so a future rewrite doesn't silently
    // drop forensic surface.
    const runOneVariantHedraStart = src.indexOf('async function runOneVariantHedra');
    const runOneVariantHedraEnd = src.indexOf('export function pickElevenLabsVoiceForVariant');
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

// =====================================================================
// Polish-21.0.1 hotfix regression pins (job 52923be6 diagnostic):
//   - voice_id field must carry a UUID (not a name)
//   - scene_description passes a minimum-length gate before being
//     sent as text_prompt (silently-accepted "Aged Man" fixed)
//   - runOneVariantHedra loud-logs the exact submit payload so a
//     future regression surfaces without a first-call-only fire
// =====================================================================

describe('Polish-21.0.1: validateHedraSpecMinLengths', () => {
  it('accepts a well-formed 50-80 word scene_description + normal script', () => {
    const spec = {
      scene: {
        scene_description:
          "A 34-year-old woman with light brown hair sits in the driver's seat of a parked dark-interior SUV, chest-up dashboard-mounted phone framing.",
        script: 'I swear to god, I was spending $80 a month on face serums.',
      },
    };
    expect(validateHedraSpecMinLengths(spec)).toEqual({ ok: true });
  });

  it('rejects the exact job 52923be6 failure shape — "Aged Man" scene_description', () => {
    const spec = {
      scene: {
        scene_description: 'Aged Man',
        script: 'valid script text here',
      },
    };
    const r = validateHedraSpecMinLengths(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/scene_description that is too short/);
      expect(r.reason).toMatch(new RegExp(`≥${HEDRA_MIN_SCENE_DESCRIPTION_CHARS}`));
    }
  });

  it('trims whitespace before measuring length (whitespace-padded short values still fail)', () => {
    const spec = {
      scene: {
        scene_description: '   Aged Man   ' + ' '.repeat(80), // char count > gate but trimmed length < gate
        script: 'valid script text',
      },
    };
    const r = validateHedraSpecMinLengths(spec);
    expect(r.ok).toBe(false);
  });

  it('rejects suspiciously short scripts', () => {
    const spec = {
      scene: {
        scene_description:
          'A well-formed 50-80 word scene description that comfortably clears the minimum-length gate at forty characters.',
        script: 'hi',
      },
    };
    const r = validateHedraSpecMinLengths(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/script that is too short/);
      expect(r.reason).toMatch(new RegExp(`≥${HEDRA_MIN_SCRIPT_CHARS}`));
    }
  });

  it('gate thresholds are exported for cross-file assertions', () => {
    expect(HEDRA_MIN_SCENE_DESCRIPTION_CHARS).toBe(40);
    expect(HEDRA_MIN_SCRIPT_CHARS).toBe(8);
  });
});

describe('Polish-21.0.1: worker text_prompt threading + pre-submit log', () => {
  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('runClaudeAdSpecHedra runs validateHedraSpecMinLengths AFTER parse succeeds', async () => {
    const src = await readSrc();
    // Regression pin: the length gate must run AFTER
    // parseVideoAdSpecHedra returns a spec but BEFORE the spec is
    // handed back to the worker. If the gate is dropped or moved
    // out of order, a short scene_description would silently ship
    // to Hedra as text_prompt (the exact 52923be6 failure mode).
    const parseIdx = src.indexOf('const parsed = parseVideoAdSpecHedra(rawText)');
    const gateIdx = src.indexOf('validateHedraSpecMinLengths(parsed)');
    expect(parseIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(parseIdx);
  });

  it('runOneVariantHedra loud-logs voice_id + text_prompt + script BEFORE the submit step', async () => {
    const src = await readSrc();
    // Job 52923be6 diagnostic hardening: the hedra-video client's
    // first-call diagnostic fires only ONCE per worker cold-start.
    // The worker's pre-submit log fires on EVERY variant, so a
    // future regression (short scene_description, wrong field
    // mapping, voice-id-vs-name confusion) shows up in Inngest
    // logs immediately without needing a fresh cold-start.
    const runOneVariantHedraStart = src.indexOf('async function runOneVariantHedra');
    const runOneVariantHedraEnd = src.indexOf('export function pickElevenLabsVoiceForVariant');
    const hedraFn = src.slice(runOneVariantHedraStart, runOneVariantHedraEnd);
    expect(hedraFn).toMatch(/pre-submit: `/);
    expect(hedraFn).toMatch(/voice_id=\$\{voice\.id\}/);
    expect(hedraFn).toMatch(/text_prompt_chars=\$\{sceneDescription\.length\}/);
    expect(hedraFn).toMatch(/text_prompt_head=/);
    expect(hedraFn).toMatch(/script_chars=\$\{script\.length\}/);
    // Ordering: log fires BEFORE the submit step.run.
    const logIdx = hedraFn.indexOf('pre-submit:');
    const submitStepIdx = hedraFn.indexOf('hedra-submit-');
    expect(logIdx).toBeGreaterThan(-1);
    expect(submitStepIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeLessThan(submitStepIdx);
  });

  it('submitHedraGeneration call threads sceneDescription → textPrompt (not any default fallback)', async () => {
    const src = await readSrc();
    // Regression against threading a placeholder / default value
    // into text_prompt. Only sceneDescription (destructured from
    // adSpecResult.spec.scene) may occupy this slot.
    const runOneVariantHedraStart = src.indexOf('async function runOneVariantHedra');
    const runOneVariantHedraEnd = src.indexOf('export function pickElevenLabsVoiceForVariant');
    const hedraFn = src.slice(runOneVariantHedraStart, runOneVariantHedraEnd);
    expect(hedraFn).toMatch(/textPrompt: sceneDescription,/);
    expect(hedraFn).toMatch(
      /const \{ scene_description: sceneDescription, script \} = adSpecResult\.spec\.scene;/,
    );
  });

  it('parseVideoAdSpecHedra with a valid response returns the scene_description verbatim (no mutation / fallback)', async () => {
    const { parseVideoAdSpecHedra } = await import('../src/functions/generate-video-variant');
    const originalDescription =
      'A 34-year-old woman with light brown hair sits in the driver seat of a parked SUV, chest-up phone framing.';
    const originalScript = 'I swear to god, this $80 serum did nothing.';
    const raw = JSON.stringify({
      scene: { scene_description: originalDescription, script: originalScript },
    });
    const r = parseVideoAdSpecHedra(raw);
    expect(r).not.toBeNull();
    expect(r!.scene.scene_description).toBe(originalDescription);
    expect(r!.scene.script).toBe(originalScript);
  });
});

// =====================================================================
// Polish-21.0.5 hotfix regression pins:
//   - composeNanoBananaCharacterPrompt emits all six JOHN pattern
//     blocks including all three ZERO anchors + anti-AI directive
//   - parseStructuredCharacter falls back cleanly on malformed input
//   - runClaudeAdSpecHedra prompt requests the yapper scene template
//     + JOHN character schema
//   - runOneVariantHedra composes Nano Banana prompt from
//     spec.character (not the old inline template)
// =====================================================================

describe('Polish-21.0.7: composeNanoBananaCharacterPrompt (Linda pattern)', () => {
  const sampleCharacter = async () => {
    const { FALLBACK_STRUCTURED_CHARACTER } =
      await import('../src/functions/generate-video-variant');
    return FALLBACK_STRUCTURED_CHARACTER;
  };

  it('emits the Linda vertical iPhone selfie lead as block 1', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const p = composeNanoBananaCharacterPrompt(await sampleCharacter());
    // Regression pin: Polish-21.0.7 Linda lead — "fictional
    // {age}-year-old {nationality} {gender} named {name}. Generic
    // {demographic_role} appearance." Every anchor word matters.
    expect(p).toMatch(/Photorealistic vertical iPhone selfie of a fictional/);
    expect(p).toMatch(/68-year-old American female named Linda/);
    expect(p).toMatch(/Generic suburban grandmother appearance/);
    // "fictional" prevents Nano Banana from pattern-matching to
    // real people; without it the model defaults to stock-photo
    // celebrity faces.
    expect(p).toMatch(/fictional/);
  });

  it('Polish-21.0.6 tripwire preserved: three-view character-sheet framing must NOT appear', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const p = composeNanoBananaCharacterPrompt(await sampleCharacter());
    // Regression pin against Polish-21.0.5's three-view lead that
    // Character 3 interpreted as three separate people.
    expect(p).not.toMatch(/three-view/i);
    expect(p).not.toMatch(/character sheet/i);
    expect(p).not.toMatch(/front view, side view, back view/i);
  });

  it('emits PHYSICAL FEATURES block as itemized bullets with asymmetry directive', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const p = composeNanoBananaCharacterPrompt(await sampleCharacter());
    // Polish-21.0.7 anchor: itemized bullets render sharper on Nano
    // Banana than paragraphs. The "deliberately asymmetric and
    // ordinary" directive is the header that keeps bullets honest.
    expect(p).toMatch(/PHYSICAL FEATURES \(deliberately asymmetric and ordinary\):/);
    // Bullets should be marked with "- ". Each of the 8 feature
    // fields feeds one bullet.
    expect(p).toMatch(/- Shoulder-length salt-and-pepper hair/);
    expect(p).toMatch(/- Slightly uneven eye line/);
    expect(p).toMatch(/- Ordinary nose — slightly wider than average/);
    expect(p).toMatch(/- Thin lips, slightly asymmetric mouth/);
    expect(p).toMatch(/- Warm hazel eyes with visible crow/);
    expect(p).toMatch(/- Soft jawline with mild jowls/);
    expect(p).toMatch(
      /- Oval face with natural fullness at the cheeks, NOT chiseled, NOT model-shaped/,
    );
    expect(p).toMatch(/- Clothing: Faded navy cotton crewneck/);
  });

  it('emits the SKIN REALISM MANDATE with ALL THREE ZERO anchors preserved (Polish-21.0.5 continuity)', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const p = composeNanoBananaCharacterPrompt(await sampleCharacter());
    // Polish-21.0.7 keeps the Polish-21.0.5 ZERO anchors verbatim
    // AND adds "ZERO airbrushing" from the Linda template — belt
    // and suspenders against beauty-filter defaults.
    expect(p).toMatch(/SKIN REALISM MANDATE: Real \d+-year-old skin/);
    expect(p).toMatch(/ZERO airbrushing\./);
    expect(p).toMatch(/ZERO beauty filters\./);
    expect(p).toMatch(/ZERO skin smoothing\./);
    expect(p).toMatch(/ZERO AI plastic-skin artifacts\./);
    // Fictional-everyperson clause preserved.
    expect(p).toMatch(/not a model, not an actor, not an AI-generated character\./);
    // Linda-shape age-appropriate detail from FALLBACK.
    expect(p).toMatch(/faint age spots on the cheekbones/);
  });

  it('includes stubble line only when skin_color_for_stubble != "none"', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const female = await sampleCharacter();
    const promptFemale = composeNanoBananaCharacterPrompt(female);
    // Sample fallback has skin_color_for_stubble='none' → no stubble line.
    expect(promptFemale).not.toMatch(/stubble shadow/);

    const male = { ...female, gender: 'male' as const, skin_color_for_stubble: 'grey' as const };
    const promptMale = composeNanoBananaCharacterPrompt(male);
    expect(promptMale).toMatch(/Real grey stubble shadow on upper lip and jaw/);
    expect(promptMale).toMatch(/one day of missed shaving/);
  });

  it('emits the CRITICAL ANTI-CELEBRITY DIRECTIVE block with named examples + anonymous-not-attractive reframe + regenerate self-check', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const p = composeNanoBananaCharacterPrompt(await sampleCharacter());
    // Polish-21.0.7 NEW block. Every anchor here is essential —
    // Nano Banana pattern-matches to famous training-data faces
    // without these named-example steers.
    expect(p).toMatch(/CRITICAL ANTI-CELEBRITY DIRECTIVE:/);
    expect(p).toMatch(/DELIBERATELY GENERIC and FORGETTABLE/);
    // Named actress examples — at least 8 to hit the operator's
    // spec minimum.
    expect(p).toMatch(/Meryl Streep/);
    expect(p).toMatch(/Helen Mirren/);
    expect(p).toMatch(/Jane Fonda/);
    expect(p).toMatch(/Diane Keaton/);
    expect(p).toMatch(/Judi Dench/);
    // News + politician sub-categories.
    expect(p).toMatch(/Barbara Walters/);
    expect(p).toMatch(/Diane Sawyer/);
    expect(p).toMatch(/Hillary Clinton/);
    expect(p).toMatch(/Nancy Pelosi/);
    // Anti-attractive reframe.
    expect(p).toMatch(/Aim for ANONYMOUS, not ATTRACTIVE/);
    expect(p).toMatch(/intentionally unremarkable/);
    // Regenerate self-check.
    expect(p).toMatch(/If the face looks like a TV .+ character, regenerate/);
    // "real human you'd walk past on the street and forget" anchor.
    expect(p).toMatch(/walk past on the street and forget/);
  });

  it('anti-celeb directive lists at least 8 named examples across categories', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const p = composeNanoBananaCharacterPrompt(await sampleCharacter());
    // Count "listable" named examples in the anti-celeb directive
    // via the fixture roster. Operator's spec requires 8-12 actress
    // + 4-6 news + 4-6 politician. Total floor: 8 combined
    // (should easily clear with the FALLBACK Linda roster).
    const antiCelebSection = p.slice(p.indexOf('CRITICAL ANTI-CELEBRITY DIRECTIVE'));
    const namedExamples = [
      'Meryl Streep',
      'Helen Mirren',
      'Jane Fonda',
      'Diane Keaton',
      'Sally Field',
      'Goldie Hawn',
      'Susan Sarandon',
      'Glenn Close',
      'Judi Dench',
      'Maggie Smith',
      'Barbara Walters',
      'Diane Sawyer',
      'Katie Couric',
      'Oprah',
      'Ellen DeGeneres',
      'Hillary Clinton',
      'Nancy Pelosi',
      'Barbara Bush',
      'Michelle Obama',
    ];
    const hits = namedExamples.filter((n) => antiCelebSection.includes(n));
    expect(hits.length).toBeGreaterThanOrEqual(8);
  });

  it('emits "Shot on iPhone front camera" camera anchor (Polish-21.0.5 continuity)', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const p = composeNanoBananaCharacterPrompt(await sampleCharacter());
    // Polish-21.0.5 anchor preserved — the exact phrase steers
    // Nano Banana's aspect-ratio + amateur-selfie aesthetic.
    expect(p).toMatch(/Shot on iPhone front camera, 9:16 vertical, natural daylight from/);
    expect(p).toMatch(/slightly shaky handheld feel/);
  });

  it('emits the anti-AI directive tail (Kling 3.0 guide anchor)', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const p = composeNanoBananaCharacterPrompt(await sampleCharacter());
    expect(p).toMatch(
      /ABSOLUTELY NO phones, cameras, screens, social media UI, floating text, or digital overlays visible anywhere in the frame\./,
    );
  });

  it('gender-conditioned pronoun in the fictional-everyperson clause', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const female = await sampleCharacter();
    expect(composeNanoBananaCharacterPrompt(female)).toMatch(
      /She must look like a real \d+-year-old/,
    );
    const male = { ...female, gender: 'male' as const };
    expect(composeNanoBananaCharacterPrompt(male)).toMatch(/He must look like a real \d+-year-old/);
  });

  it('threads demographic_role into three places: lead, SKIN REALISM, and anti-celeb regenerate check', async () => {
    const { composeNanoBananaCharacterPrompt } =
      await import('../src/functions/generate-video-variant');
    const char = {
      ...(await sampleCharacter()),
      demographic_role: 'retired schoolteacher',
    };
    const p = composeNanoBananaCharacterPrompt(char);
    // Lead: "Generic retired schoolteacher appearance."
    expect(p).toMatch(/Generic retired schoolteacher appearance/);
    // SKIN REALISM: "must look like a real {age}-year-old retired schoolteacher"
    expect(p).toMatch(/real \d+-year-old retired schoolteacher, not a model/);
    // Anti-celeb: "TV retired schoolteacher character, regenerate"
    expect(p).toMatch(/TV retired schoolteacher character, regenerate/);
  });
});

describe('Polish-21.0.7: parseStructuredCharacter (Linda block parser)', () => {
  it('parses a well-formed Linda character block', async () => {
    const { parseStructuredCharacter } = await import('../src/functions/generate-video-variant');
    const raw = {
      name: 'Marcus',
      age: 42,
      nationality: 'Filipino',
      gender: 'male',
      demographic_role: 'middle-aged office worker',
      hair_bullet: 'Short jet-black hair, slightly messy, NOT styled, NOT symmetrical',
      eye_asymmetry_bullet:
        'Slightly uneven eye line — left eyelid heavier than right (natural asymmetry)',
      nose_bullet: 'Ordinary nose — small bump at the bridge and slightly wide nostrils',
      mouth_bullet:
        'Medium lips, slightly asymmetric mouth, natural slight downturn on the right side',
      eye_color_and_age_detail:
        "Dark warm brown eyes with faint crow's feet and mild under-eye shadows",
      jaw_bullet: 'Soft jawline with mild jowl weight (age-appropriate)',
      face_shape_bullet: 'Broad oval face, NOT chiseled, NOT model-shaped',
      clothing_bullet:
        'Faded charcoal cotton polo with honest wear at the collar — not new, not designer',
      setting_paragraph:
        'Home office corner, cool morning light from a north-facing window off-camera. Cluttered lived-in feel.',
      skin_age_appropriate_detail:
        'faint sun-spot pigmentation on cheekbones, natural pore texture on nose, mild redness on upper cheeks',
      skin_color_for_stubble: 'black',
      anti_celeb_actress_examples: ['Meryl Streep', 'Helen Mirren', 'Jane Fonda', 'Diane Keaton'],
      anti_celeb_news_examples: ['Barbara Walters', 'Diane Sawyer'],
      anti_celeb_politician_examples: ['Nancy Pelosi', 'Hillary Clinton'],
    };
    const r = parseStructuredCharacter(raw);
    expect(r.name).toBe('Marcus');
    expect(r.age).toBe(42);
    expect(r.gender).toBe('male');
    expect(r.skin_color_for_stubble).toBe('black');
    expect(r.demographic_role).toBe('middle-aged office worker');
    expect(r.hair_bullet).toMatch(/Short jet-black hair/);
    expect(r.anti_celeb_actress_examples).toHaveLength(4);
  });

  it('falls back to FALLBACK_STRUCTURED_CHARACTER when Claude drops a required field', async () => {
    const { parseStructuredCharacter, FALLBACK_STRUCTURED_CHARACTER } =
      await import('../src/functions/generate-video-variant');
    // Missing hair_description → whole-record fallback (partial
    // hydration would produce a half-Claude / half-fallback shape).
    const partial = {
      name: 'Marcus',
      age: 42,
      nationality: 'Filipino',
      gender: 'male',
      face_description: 'x',
      body_posture_clothing: 'x',
      skin_color_for_stubble: 'black',
      role_description: 'x',
      setting_description: 'x',
    };
    expect(parseStructuredCharacter(partial)).toEqual(FALLBACK_STRUCTURED_CHARACTER);
  });

  it('falls back on non-object / null / array inputs', async () => {
    const { parseStructuredCharacter, FALLBACK_STRUCTURED_CHARACTER } =
      await import('../src/functions/generate-video-variant');
    expect(parseStructuredCharacter(null)).toEqual(FALLBACK_STRUCTURED_CHARACTER);
    expect(parseStructuredCharacter(undefined)).toEqual(FALLBACK_STRUCTURED_CHARACTER);
    expect(parseStructuredCharacter('string')).toEqual(FALLBACK_STRUCTURED_CHARACTER);
    expect(parseStructuredCharacter([])).toEqual(FALLBACK_STRUCTURED_CHARACTER);
  });

  it('rejects invalid skin_color_for_stubble enum values (falls back)', async () => {
    const { parseStructuredCharacter, FALLBACK_STRUCTURED_CHARACTER } =
      await import('../src/functions/generate-video-variant');
    const badStubble = {
      name: 'x',
      age: 30,
      nationality: 'x',
      gender: 'male',
      hair_description: 'x',
      face_description: 'x',
      body_posture_clothing: 'x',
      skin_color_for_stubble: 'PURPLE',
      role_description: 'x',
      setting_description: 'x',
    };
    expect(parseStructuredCharacter(badStubble)).toEqual(FALLBACK_STRUCTURED_CHARACTER);
  });

  it('rejects invalid gender enum values (falls back)', async () => {
    const { parseStructuredCharacter, FALLBACK_STRUCTURED_CHARACTER } =
      await import('../src/functions/generate-video-variant');
    const badGender = {
      name: 'x',
      age: 30,
      nationality: 'x',
      gender: 'nonbinary',
      hair_description: 'x',
      face_description: 'x',
      body_posture_clothing: 'x',
      skin_color_for_stubble: 'none',
      role_description: 'x',
      setting_description: 'x',
    };
    expect(parseStructuredCharacter(badGender)).toEqual(FALLBACK_STRUCTURED_CHARACTER);
  });

  it('rejects non-positive / non-finite age (falls back)', async () => {
    const { parseStructuredCharacter, FALLBACK_STRUCTURED_CHARACTER } =
      await import('../src/functions/generate-video-variant');
    for (const age of [0, -3, NaN, Infinity, 'thirty']) {
      const bad = {
        name: 'x',
        age,
        nationality: 'x',
        gender: 'male',
        hair_description: 'x',
        face_description: 'x',
        body_posture_clothing: 'x',
        skin_color_for_stubble: 'none',
        role_description: 'x',
        setting_description: 'x',
      };
      expect(parseStructuredCharacter(bad)).toEqual(FALLBACK_STRUCTURED_CHARACTER);
    }
  });
});

describe('Polish-21.0.7: parseVideoAdSpecHedra with Linda character block', () => {
  it('hydrates the Linda character field when Claude output includes it', async () => {
    const { parseVideoAdSpecHedra } = await import('../src/functions/generate-video-variant');
    const raw = JSON.stringify({
      scene: {
        scene_description:
          'A 34-year-old woman films herself in her kitchen — morning natural light.',
        script: 'Real script text here.',
      },
      character: {
        name: 'Elena',
        age: 34,
        nationality: 'American',
        gender: 'female',
        demographic_role: 'thirty-something everyperson',
        hair_bullet: 'Dark brown hair pulled into a loose low bun, slightly messy, NOT styled',
        eye_asymmetry_bullet: 'Slightly uneven eye line — right eyelid heavier than left',
        nose_bullet: 'Ordinary nose — narrow bridge with faint bump',
        mouth_bullet: 'Full lips, slightly asymmetric smile, downturn on the left corner',
        eye_color_and_age_detail: 'Warm hazel eyes with faint freckle line across the bridge',
        jaw_bullet: 'Soft jawline with light cheek fullness',
        face_shape_bullet: 'Oval face, NOT chiseled, NOT model-shaped, natural cheek fullness',
        clothing_bullet: 'Worn navy hoodie with fraying cuffs — not new, not designer',
        setting_paragraph:
          'Kitchen counter, cool morning light through a window. Cluttered morning-breakfast feel.',
        skin_age_appropriate_detail:
          'faint freckling across the nose, subtle acne scarring on the chin, natural pore texture',
        skin_color_for_stubble: 'none',
        anti_celeb_actress_examples: [
          'Anne Hathaway',
          'Emma Stone',
          'Natalie Portman',
          'Jennifer Lawrence',
        ],
        anti_celeb_news_examples: ['Robin Meade', "Norah O'Donnell"],
        anti_celeb_politician_examples: ['Chelsea Clinton', 'Ivanka Trump'],
      },
    });
    const r = parseVideoAdSpecHedra(raw);
    expect(r).not.toBeNull();
    expect(r!.character.name).toBe('Elena');
    expect(r!.character.setting_paragraph).toMatch(/kitchen counter/i);
    expect(r!.character.hair_bullet).toMatch(/loose low bun/);
  });

  it('falls back to FALLBACK_STRUCTURED_CHARACTER when scene is valid but character is missing', async () => {
    const { parseVideoAdSpecHedra, FALLBACK_STRUCTURED_CHARACTER } =
      await import('../src/functions/generate-video-variant');
    const raw = JSON.stringify({
      scene: { scene_description: 'valid scene text with enough length here.', script: 'hi hi hi' },
    });
    const r = parseVideoAdSpecHedra(raw);
    expect(r).not.toBeNull();
    // Regression pin: pipeline moves forward with a generic
    // everyperson instead of blowing up. Character-drop was a
    // real risk during Polish-21 Commit 2 (maxTokens truncation).
    expect(r!.character).toEqual(FALLBACK_STRUCTURED_CHARACTER);
  });

  it('falls back when scene is valid but character is malformed', async () => {
    const { parseVideoAdSpecHedra, FALLBACK_STRUCTURED_CHARACTER } =
      await import('../src/functions/generate-video-variant');
    const raw = JSON.stringify({
      scene: { scene_description: 'valid scene text with enough length here.', script: 'hi hi hi' },
      character: { name: 'Half', age: 30 }, // missing everything else
    });
    const r = parseVideoAdSpecHedra(raw);
    expect(r).not.toBeNull();
    expect(r!.character).toEqual(FALLBACK_STRUCTURED_CHARACTER);
  });
});

describe('Polish-21.0.7: runClaudeAdSpecHedra system prompt (Linda character + yapper scene)', () => {
  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('requests a character block with Linda itemized-bullet fields', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runClaudeAdSpecHedra');
    const end = src.indexOf('// ---', start);
    const promptFn = src.slice(start, end);
    // Every required Linda-shape bullet field must be in the schema
    // Claude sees.
    expect(promptFn).toMatch(/"demographic_role":/);
    expect(promptFn).toMatch(/"hair_bullet":/);
    expect(promptFn).toMatch(/"eye_asymmetry_bullet":/);
    expect(promptFn).toMatch(/"nose_bullet":/);
    expect(promptFn).toMatch(/"mouth_bullet":/);
    expect(promptFn).toMatch(/"eye_color_and_age_detail":/);
    expect(promptFn).toMatch(/"jaw_bullet":/);
    expect(promptFn).toMatch(/"face_shape_bullet":/);
    expect(promptFn).toMatch(/"clothing_bullet":/);
    expect(promptFn).toMatch(/"setting_paragraph":/);
    expect(promptFn).toMatch(/"skin_age_appropriate_detail":/);
    expect(promptFn).toMatch(/"skin_color_for_stubble":/);
    // Anti-celebrity arrays.
    expect(promptFn).toMatch(/"anti_celeb_actress_examples":/);
    expect(promptFn).toMatch(/"anti_celeb_news_examples":/);
    expect(promptFn).toMatch(/"anti_celeb_politician_examples":/);
  });

  it('itemized-bullets + anti-celebrity directives are present (Linda pattern anchors)', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runClaudeAdSpecHedra');
    const end = src.indexOf('// ---', start);
    const promptFn = src.slice(start, end);
    // Regression pin: the exact phrasing that steers Claude to
    // itemized bullets over paragraphs (bullets render sharper).
    expect(promptFn).toMatch(/ITEMIZED BULLETS/);
    expect(promptFn).toMatch(/NOT flowing paragraphs/);
    expect(promptFn).toMatch(/SPECIFIC imperfection/);
    // Anti-attractive reframe in Claude's directive.
    expect(promptFn).toMatch(/ANONYMOUS, not ATTRACTIVE/);
    // Anti-celebrity guidance for Claude's example generation.
    expect(promptFn).toMatch(/ANTI-CELEBRITY/i);
    expect(promptFn).toMatch(/pattern-matches to famous faces/);
    // Wear detail preserved from Polish-21.0.5.
    expect(promptFn).toMatch(/wear condition/);
    expect(promptFn).toMatch(/pristine outfits/i);
  });

  it('scene_description template names the yapper anchor components (age, framing, lighting, tone, dialogue)', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runClaudeAdSpecHedra');
    const end = src.indexOf('// ---', start);
    const promptFn = src.slice(start, end);
    expect(promptFn).toMatch(/dashboard-mounted phone chest-up/);
    expect(promptFn).toMatch(/confessional TikTok energy/);
    expect(promptFn).toMatch(/Natural micro-expressions/);
    expect(promptFn).toMatch(/Vertical 9:16/);
    // Yapper anchor requires "She says:" / "He says:" INSIDE the
    // scene_description prose.
    expect(promptFn).toMatch(/She\/He says/);
  });

  it('script field explicitly forbids speaker attribution (goes to TTS verbatim)', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runClaudeAdSpecHedra');
    const end = src.indexOf('// ---', start);
    const promptFn = src.slice(start, end);
    // Scene CAN have "She says:" (narrative framing for Hedra
    // text_prompt), but script CANNOT (ElevenLabs would speak
    // "She says" literally).
    expect(promptFn).toMatch(/NO stage directions, NO speaker attribution/);
    expect(promptFn).toMatch(/verbatim to ElevenLabs TTS/);
  });

  it('drops sound_texture (Hedra + ElevenLabs handle audio natively)', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runClaudeAdSpecHedra');
    const end = src.indexOf('// ---', start);
    const promptFn = src.slice(start, end);
    expect(promptFn).not.toMatch(/sound_texture/);
  });

  it('rejects bracketed Sora-era sections (Polish-20.0.3 anchor still applies)', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runClaudeAdSpecHedra');
    const end = src.indexOf('// ---', start);
    const promptFn = src.slice(start, end);
    expect(promptFn).toMatch(/NO bracketed sections/);
    expect(promptFn).toMatch(/IGNORE it — do NOT copy the structure/);
  });

  it('KEEPS Polish-19.4.2 verbatim source-script preservation (hooks + dollar amounts + ALL CAPS)', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runClaudeAdSpecHedra');
    const end = src.indexOf('// ---', start);
    const promptFn = src.slice(start, end);
    expect(promptFn).toMatch(/SOURCE-SCRIPT PRESERVATION/);
    expect(promptFn).toMatch(/hook openers/);
    expect(promptFn).toMatch(/dollar amounts/);
    expect(promptFn).toMatch(/ALL CAPS emphasis words/);
  });
});

describe('Polish-21.0.5: runOneVariantHedra uses composeNanoBananaCharacterPrompt', () => {
  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('worker composes the Nano Banana prompt via composeNanoBananaCharacterPrompt(character) — not an inline template', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runOneVariantHedra');
    const end = src.indexOf('export function pickElevenLabsVoiceForVariant');
    const fn = src.slice(start, end);
    // Regression pin: the JOHN composer must be called from the
    // worker. Inlining the prompt again would regress to the
    // Polish-21 Commit 2 AI-CGI output.
    expect(fn).toMatch(/composeNanoBananaCharacterPrompt\(character\)/);
    // AND the old inline "Scene: ${sceneDescription}" template
    // MUST NOT reappear.
    expect(fn).not.toMatch(/Photoreal amateur smartphone selfie photograph, vertical 9:16 framing/);
  });

  it('worker logs character block + Nano Banana prompt length to composite metadata (forensics)', async () => {
    const src = await readSrc();
    const start = src.indexOf('async function runOneVariantHedra');
    const end = src.indexOf('export function pickElevenLabsVoiceForVariant');
    const fn = src.slice(start, end);
    expect(fn).toMatch(/character,/);
    expect(fn).toMatch(/nano_banana_prompt_chars: imagePrompt\.length/);
  });
});

describe('Polish-21.0.3: worker threads durationSeconds into submitHedraGeneration', () => {
  const readSrc = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(
      new URL('../src/functions/generate-video-variant.ts', import.meta.url),
      'utf8',
    );
  };

  it('runOneVariantHedra passes durationSeconds: targetSeconds to submitHedraGeneration', async () => {
    // Ties the worker's Hedra submit call site to the resolved
    // target duration from resolveAutoVideoDuration (Polish-19.3.1
    // fallback chain). Regression against a future refactor
    // dropping the field back to undefined — Hedra would return
    // HTTP 422 "Field required" on generated_video_inputs.duration_ms.
    const src = await readSrc();
    const submitStart = src.indexOf('return submitHedraGeneration({');
    expect(submitStart).toBeGreaterThan(-1);
    const submitEnd = src.indexOf('});', submitStart);
    const submitCall = src.slice(submitStart, submitEnd);
    expect(submitCall).toMatch(/durationSeconds: targetSeconds,/);
  });
});
