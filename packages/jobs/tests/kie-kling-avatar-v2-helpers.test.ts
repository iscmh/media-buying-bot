/**
 * Polish-19: pure-helper tests for the Kling Avatar v2 worker.
 * Inngest's step harness is mocked out — we cover the decisions
 * the worker delegates to plain functions.
 */
import { describe, expect, it } from 'vitest';
import {
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
