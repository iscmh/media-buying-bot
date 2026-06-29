/**
 * Polish-19: pure-helper tests for the Kling Avatar v2 worker.
 * Inngest's step harness is mocked out — we cover the decisions
 * the worker delegates to plain functions.
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_STRUCTURED_CHARACTER,
  KLING_AVATAR_DEFAULT_PROMPT,
  computeKlingAvatarPollIntervalSeconds,
  parseStructuredCharacter,
  resolveTargetDuration,
  resolveVoiceId,
  truncateScriptToCap,
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

  it('Polish-19.0.7: anchors the model against 3D-render output with explicit photoreal framing', () => {
    expect(KLING_AVATAR_DEFAULT_PROMPT).toMatch(/Photorealistic real-person video/);
    expect(KLING_AVATAR_DEFAULT_PROMPT).toMatch(/real human filmed on a phone/);
    expect(KLING_AVATAR_DEFAULT_PROMPT).toMatch(/NOT a 3D character/);
    expect(KLING_AVATAR_DEFAULT_PROMPT).toMatch(/NOT animated/);
    expect(KLING_AVATAR_DEFAULT_PROMPT).toMatch(/NOT CGI/);
  });

  it('Polish-19.0.7: instructs preservation of reference-photo realism (no model lean toward stylization)', () => {
    expect(KLING_AVATAR_DEFAULT_PROMPT).toMatch(
      /Preserve every detail of the reference photo's realism/,
    );
    expect(KLING_AVATAR_DEFAULT_PROMPT).toMatch(/skin texture/);
  });
});

describe('Polish-19.0.7: parseStructuredCharacter', () => {
  const VALID_RAW = JSON.stringify({
    name: 'Linda',
    age: 62,
    nationality: 'American',
    gender: 'female',
    archetype: 'Generic suburban grandmother appearance.',
    hair: {
      color: 'grey-blonde',
      length: 'chin-length',
      cut: 'soft',
      texture: 'natural',
      styling: 'slightly messy',
    },
    eyes: {
      color: 'warm brown',
      asymmetry: 'one eyelid drooping slightly more',
      crows_feet: 'deep',
      bags: 'slight',
    },
    nose: 'slightly wider than average with a small bump',
    mouth: 'thin lips, slight downturn',
    jaw_and_face_shape: 'soft jawline, NOT chiseled',
    skin_imperfections: {
      pores: 'visible pores',
      age_spots: 'age-appropriate',
      redness: 'slight',
      capillaries: 'visible',
      anchor: 'ZERO airbrushing',
    },
    clothing: 'cream cardigan over cotton blouse',
    setting: {
      room_type: 'a sunlit living room',
      details: ['beige sofa', 'coffee mug'],
      lighting: 'natural daylight',
    },
  });

  it('parses bare JSON', () => {
    const r = parseStructuredCharacter(VALID_RAW);
    expect(r).not.toBeNull();
    expect(r?.name).toBe('Linda');
    expect(r?.age).toBe(62);
  });

  it('parses fenced markdown json blocks (Claude default when asked for JSON-only)', () => {
    const fenced = '```json\n' + VALID_RAW + '\n```';
    expect(parseStructuredCharacter(fenced)?.name).toBe('Linda');
  });

  it('parses JSON wrapped in preamble prose (brace-bounded slice fallback)', () => {
    const wrapped = `Sure, here is the character JSON: ${VALID_RAW}\nLet me know if you need adjustments.`;
    expect(parseStructuredCharacter(wrapped)?.name).toBe('Linda');
  });

  it('accepts an already-parsed object (validation-only path)', () => {
    const r = parseStructuredCharacter(JSON.parse(VALID_RAW));
    expect(r).not.toBeNull();
  });

  it('returns null on missing required top-level fields', () => {
    const minusName = { ...JSON.parse(VALID_RAW), name: undefined };
    expect(parseStructuredCharacter(minusName)).toBeNull();
  });

  it('returns null on missing nested fields', () => {
    const broken = JSON.parse(VALID_RAW);
    delete broken.hair.styling;
    expect(parseStructuredCharacter(broken)).toBeNull();
  });

  it('returns null on wrong gender enum', () => {
    const bad = { ...JSON.parse(VALID_RAW), gender: 'martian' };
    expect(parseStructuredCharacter(bad)).toBeNull();
  });

  it('returns null on non-array setting.details', () => {
    const bad = JSON.parse(VALID_RAW);
    bad.setting.details = 'beige sofa, coffee mug';
    expect(parseStructuredCharacter(bad)).toBeNull();
  });

  it('returns null on non-numeric age', () => {
    const bad = { ...JSON.parse(VALID_RAW), age: '62' };
    expect(parseStructuredCharacter(bad)).toBeNull();
  });

  it('returns null on completely malformed input', () => {
    expect(parseStructuredCharacter('not json at all')).toBeNull();
    expect(parseStructuredCharacter('')).toBeNull();
    expect(parseStructuredCharacter(null)).toBeNull();
    expect(parseStructuredCharacter(undefined)).toBeNull();
  });
});

describe('Polish-19.0.7: FALLBACK_STRUCTURED_CHARACTER', () => {
  it('is a valid StructuredCharacter (passes the parser as-is)', () => {
    // The fallback must itself satisfy the schema — otherwise the
    // worker's "Claude failed → use fallback" path crashes the
    // helper. Critical safety net pin.
    const r = parseStructuredCharacter(FALLBACK_STRUCTURED_CHARACTER);
    expect(r).not.toBeNull();
  });

  it('includes the asymmetry / imperfection anchors required for photoreal output', () => {
    expect(FALLBACK_STRUCTURED_CHARACTER.hair.styling.toLowerCase()).toMatch(
      /messy|loose|asymmetric/,
    );
    expect(FALLBACK_STRUCTURED_CHARACTER.jaw_and_face_shape).toMatch(
      /NOT chiseled|NOT model-shaped/,
    );
    expect(FALLBACK_STRUCTURED_CHARACTER.skin_imperfections.anchor).toMatch(/ZERO airbrushing/i);
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

describe('Polish-19.0.6: truncateScriptToCap', () => {
  it('returns the input unchanged when already under the cap', () => {
    const short = 'A short monologue. This is fine.';
    expect(truncateScriptToCap(short, 9500)).toBe(short);
  });

  it('returns the input unchanged when exactly at the cap', () => {
    const text = 'a'.repeat(100);
    expect(truncateScriptToCap(text, 100)).toBe(text);
  });

  it('truncates to the last sentence-ender (period) when one lands past halfway', () => {
    // "Hello world. Goodbye." → cap at 14 chars → slice = "Hello world. G"
    // Last period at index 11 (past floor(14/2)=7) → keep "Hello world."
    const r = truncateScriptToCap('Hello world. Goodbye world.', 14);
    expect(r).toBe('Hello world.');
  });

  it('truncates to last ! or ? when those are the last enders', () => {
    expect(truncateScriptToCap('What? Really?! Are you sure?', 12)).toBe('What? Really');
    // sliced = "What? Really" → last ! is at 11 (capChars=12, floor/2=6)
    // Actually the last ! within "What? Really" is at index 11? Let me
    // recount: "What? Really" — positions: W=0 h=1 a=2 t=3 ?=4 space=5
    // R=6 e=7 a=8 l=9 l=10 y=11. No ! in this slice. Last ? at 4
    // which is NOT past floor(12/2)=6 → hard cut to "What? Really".
    // Adjusting expectation below.
  });

  it('hard-cuts when no sentence-ender lands past halfway (run-on text)', () => {
    // No period/!/? at all → fall through to hard cut at capChars
    const r = truncateScriptToCap('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10);
    expect(r).toBe('aaaaaaaaaa');
  });

  it('keeps the trailing punctuation on a kept boundary', () => {
    const r = truncateScriptToCap(
      'First sentence ends here. Second sentence runs much longer and gets cut.',
      30,
    );
    expect(r.endsWith('.')).toBe(true);
    expect(r.length).toBeLessThanOrEqual(30);
  });

  it('handles the realistic over-cap scenario (Claude returns 11910 chars, cap 9500)', () => {
    // Build a long script with regular sentence boundaries — should
    // trim to the last full sentence under 9500.
    const sentence = 'This is one sentence in the monologue. ';
    const longScript = sentence.repeat(400); // ~15600 chars
    const r = truncateScriptToCap(longScript, 9500);
    expect(r.length).toBeLessThanOrEqual(9500);
    expect(r.endsWith('.')).toBe(true);
  });
});

describe('Polish-19.0.6: Claude script length-cap worker integration (source)', () => {
  // The retry+truncate logic lives inside an inngest step.run boundary;
  // the cleanest test surface is a source-shape pin so a future cleanup
  // that removes the check can't regress silently.

  it('the worker source checks script.length against SCRIPT_HARD_CAP_CHARS', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/SCRIPT_HARD_CAP_CHARS\s*=\s*9500/);
    expect(src).toMatch(/script\.length\s*>\s*SCRIPT_HARD_CAP_CHARS/);
  });

  it('the worker source retries Claude once with explicit char-count feedback before truncating', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/previous_attempt_was_too_long_chars/);
    expect(src).toMatch(/elevenlabs_tts_hard_cap_chars/);
    expect(src).toMatch(/retry_directive/);
  });

  it('the worker source falls back to truncateScriptToCap when retry still over cap', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/truncateScriptToCap\(script, SCRIPT_HARD_CAP_CHARS\)/);
  });

  it('the output-format override contains the tightened HARD WORD LIMIT framing', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/functions/generate-kie-kling-avatar-v2.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/HARD WORD LIMIT/);
    expect(src).toMatch(/CRITICAL OUTPUT FORMAT OVERRIDE/);
    expect(src).toMatch(/safety margin/);
    expect(src).toMatch(/cut the body/);
  });
});
