/**
 * Polish-19: pure-helper tests for the Kling Avatar v2 worker.
 * Inngest's step harness is mocked out — we cover the decisions
 * the worker delegates to plain functions.
 */
import { describe, expect, it } from 'vitest';
import {
  KLING_AVATAR_DEFAULT_PROMPT,
  computeKlingAvatarPollIntervalSeconds,
  resolveTargetDuration,
  resolveVoiceId,
} from '../src/functions/generate-kie-kling-avatar-v2';

describe('Polish-19: resolveTargetDuration', () => {
  it('defaults to 30s when metadata is null', () => {
    expect(resolveTargetDuration(null)).toBe(30);
  });

  it('defaults to 30s when source_duration_seconds is missing', () => {
    expect(resolveTargetDuration({ other: 'fields' })).toBe(30);
  });

  it('defaults to 30s for non-numeric / zero / NaN durations', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 'twelve' })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: 0 })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: NaN })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: -5 })).toBe(30);
  });

  it('clamps short detections to the 8s floor (prevents 3s broken-thumbnail outliers)', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 3 })).toBe(8);
    expect(resolveTargetDuration({ source_duration_seconds: 7.4 })).toBe(8);
  });

  it('clamps long detections to the 5-minute (300s) hard ceiling (kie.ai max)', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 600 })).toBe(300);
    expect(resolveTargetDuration({ source_duration_seconds: 4000 })).toBe(300);
  });

  it('rounds fractional seconds up so the worker never under-generates', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 18.3 })).toBe(19);
    expect(resolveTargetDuration({ source_duration_seconds: 45.9 })).toBe(46);
  });

  it('passes through canonical mid-range durations unchanged', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 30 })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: 60 })).toBe(60);
    expect(resolveTargetDuration({ source_duration_seconds: 120 })).toBe(120);
    expect(resolveTargetDuration({ source_duration_seconds: 240 })).toBe(240);
  });
});

describe('Polish-19 Commit 2: resolveVoiceId', () => {
  it('returns undefined when metadata is null (worker uses client default)', () => {
    expect(resolveVoiceId(null)).toBeUndefined();
  });

  it('returns undefined when voice_id is missing', () => {
    expect(resolveVoiceId({ other: 'field' })).toBeUndefined();
  });

  it('returns undefined when voice_id is non-string or empty', () => {
    expect(resolveVoiceId({ voice_id: 42 })).toBeUndefined();
    expect(resolveVoiceId({ voice_id: null })).toBeUndefined();
    expect(resolveVoiceId({ voice_id: '' })).toBeUndefined();
    expect(resolveVoiceId({ voice_id: '   ' })).toBeUndefined();
  });

  it('returns the trimmed voice id when present', () => {
    expect(resolveVoiceId({ voice_id: 'pNInz6obpgDQGcFmaJgB' })).toBe('pNInz6obpgDQGcFmaJgB');
    expect(resolveVoiceId({ voice_id: '  EXAVITQu4vr4xnSDxMaL  ' })).toBe('EXAVITQu4vr4xnSDxMaL');
  });

  it('does NOT validate against the curated catalog — passes through unknown ids', () => {
    // Lets users supply their own custom ElevenLabs voice id; client
    // surfaces a 422 if it's actually invalid.
    expect(resolveVoiceId({ voice_id: 'custom_user_voice_id_xyz' })).toBe(
      'custom_user_voice_id_xyz',
    );
  });
});

describe('Polish-19.0.3: KLING_AVATAR_DEFAULT_PROMPT', () => {
  // Regression pin — kie.ai's Kling Avatar v2 API rejects empty prompts
  // with HTTP 500 ("prompt is required") despite the public docs
  // listing empty-string as the default. Anything that would silently
  // re-introduce the empty default (an over-zealous "this comment looks
  // redundant" cleanup, an env override, a refactor) fails these
  // assertions before it ships.
  it('is a non-empty string', () => {
    expect(typeof KLING_AVATAR_DEFAULT_PROMPT).toBe('string');
    expect(KLING_AVATAR_DEFAULT_PROMPT.length).toBeGreaterThan(0);
    expect(KLING_AVATAR_DEFAULT_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it("stays within kie.ai's documented 5000-char ceiling for the prompt field", () => {
    expect(KLING_AVATAR_DEFAULT_PROMPT.length).toBeLessThanOrEqual(5000);
  });

  it('references lipsync so the model is steered toward audio-driven mouth shapes', () => {
    expect(KLING_AVATAR_DEFAULT_PROMPT.toLowerCase()).toContain('lipsync');
  });
});

/**
 * Polish-19.0.4: lock the Claude system prompt's output-format override.
 * The worker composes getUniversalUgcMasterPrompt() (Polish-12.x voice
 * tuning) + an override that forces ONE plain-text monologue output.
 * Without this, the master prompt's multi-clip production-manual
 * instincts bleed through and the Kling worker's text input ends up
 * shaped wrong for a single-monologue lipsync run.
 *
 * The worker doesn't export the composed string (it's built per-call
 * with target word count); we re-import the helper module and inspect
 * the override function it builds.
 */
describe('Polish-19.0.4: Kling worker Claude output-format override', () => {
  // The override constant is a module-private builder, but the
  // assertions below pin its contract via the assembled string the
  // worker actually sends to Claude.
  it('the worker source contains the strict output-format override directives', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    // Pin the override's key directives so a future cleanup that
    // shortens the override surfaces here, not in a degraded live
    // generation.
    expect(src).toMatch(/Return PLAIN TEXT monologue only/);
    expect(src).toMatch(/No JSON, no markdown, no clip structure/);
    expect(src).toMatch(/First-person conversational delivery/);
    expect(src).toMatch(/Hook in first 3 seconds/);
    expect(src).toMatch(/call-to-action/);
    expect(src).toMatch(/ONE continuous monologue/);
    expect(src).toMatch(/No multi-clip breakdown/);
  });

  it('the worker layers getUniversalUgcMasterPrompt() + the override (not a hand-written one-liner)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/getUniversalUgcMasterPrompt\(\)/);
    expect(src).toMatch(/KLING_AVATAR_CLAUDE_OUTPUT_OVERRIDE/);
  });

  it('the worker uses the shared buildKlingAvatarReferencePrompt helper (not a hand-written one-liner)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/buildKlingAvatarReferencePrompt/);
    // Tripwire — the old studio-portrait one-liner that the worker
    // used pre-Polish-19.0.4 must not be reintroduced as an actual
    // prompt string. We match only the call-site shape (`prompt: [`
    // with the studio-portrait phrase), not the audit-trail comment
    // that explains why we removed it.
    expect(src).not.toMatch(/prompt\s*=\s*\[\s*'Portrait photograph/);
  });
});

describe('Polish-19.0.5: computeKlingAvatarPollIntervalSeconds', () => {
  // Locks the exponential-backoff curve used by the poll loop. Before
  // 19.0.5 the loop ran 32 × flat-10s = 5min 20s and gave up while
  // Kling was still running. The new curve: 10s start, gentle 1.15x
  // growth per attempt, capped at 30s, so 80 attempts ≈ ~38 min total
  // wall-clock — past every observed Kling run while still bounded.

  it('attempt 0 returns the initial interval (10s)', () => {
    expect(computeKlingAvatarPollIntervalSeconds(0)).toBe(10);
  });

  it('grows gently in the first several attempts', () => {
    // attempt 1: 10 * 1.15 = 11.5 → ceil = 12
    // attempt 2: 10 * 1.15^2 = 13.225 → ceil = 14
    // attempt 3: 10 * 1.15^3 = 15.21 → ceil = 16
    expect(computeKlingAvatarPollIntervalSeconds(1)).toBe(12);
    expect(computeKlingAvatarPollIntervalSeconds(2)).toBe(14);
    expect(computeKlingAvatarPollIntervalSeconds(3)).toBe(16);
  });

  it('caps at 30s on later attempts so the loop stays responsive when the result lands inside one interval window', () => {
    // 1.15^8 ≈ 3.06 → 30.6 → ceil 31 → clamp 30
    expect(computeKlingAvatarPollIntervalSeconds(8)).toBe(30);
    expect(computeKlingAvatarPollIntervalSeconds(20)).toBe(30);
    expect(computeKlingAvatarPollIntervalSeconds(79)).toBe(30);
  });

  it('clamps NaN / negative / non-finite attempt indices to the initial interval', () => {
    // All three fall into the Number.isFinite() guard and return the
    // floor — safer than letting Infinity * 1.15 propagate to step.sleep.
    expect(computeKlingAvatarPollIntervalSeconds(NaN)).toBe(10);
    expect(computeKlingAvatarPollIntervalSeconds(-3)).toBe(10);
    expect(computeKlingAvatarPollIntervalSeconds(Infinity)).toBe(10);
  });

  it('total wall-clock with POLL_MAX_ATTEMPTS=80 stays above the 20-min mark', () => {
    // Sanity check the curve actually gives us enough headroom over
    // the worst observed Kling runtime. Sum the first 80 intervals.
    let total = 0;
    for (let i = 0; i < 80; i++) total += computeKlingAvatarPollIntervalSeconds(i);
    // ~7 attempts of < 30s + 73 × 30s = roughly 2300s ≈ 38min
    expect(total).toBeGreaterThan(20 * 60); // > 20 min
    expect(total).toBeLessThan(60 * 60); // < 60 min (sanity ceiling)
  });
});

describe('Polish-19.0.5: poll-timeout taskId preservation (worker source)', () => {
  it('the timeout branch writes a status=failed creative row carrying kie_task_id + in_flight=true', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    // Pin the recovery-row shape — anything that silently regresses
    // back to "log and bail" fires here.
    expect(src).toMatch(/insert-in-flight-creative-/);
    expect(src).toMatch(/kie_task_id: submitResult\.taskId/);
    expect(src).toMatch(/in_flight: true/);
    expect(src).toMatch(/recoverable: true/);
    expect(src).toMatch(/status: 'failed'/);
  });

  it('the timeout branch console.logs the taskId + recovery curl line so ops can act manually', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/may still be in flight/);
    expect(src).toMatch(/recordInfo\?taskId=/);
  });

  it('POLL_MAX_ATTEMPTS is at least 60 (Polish-19.0.5 floor — anything lower regresses to the pre-fix wall)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    const match = src.match(/POLL_MAX_ATTEMPTS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    if (match) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(60);
    }
  });
});
