/**
 * Polish-4 → Polish-20 Commit 4: failover decision tree tests.
 *
 * Post-Commit-4 the cinematic_voiceover path is gone with the
 * ElevenLabs deletion, so `pickFailoverFormat` returns null for
 * every call. The tests here just pin that reality.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAllProvidersFailedMessage,
  failoverEventName,
  pickFailoverFormat,
} from '../src/lib/failover';

describe('Polish-20 Commit 4: pickFailoverFormat has no fallback path', () => {
  it('returns null for any input format (cinematic path retired)', () => {
    for (const format of ['avatar_talking_head', 'cinematic_voiceover', 'unknown']) {
      const r = pickFailoverFormat(format, { heygen: true });
      expect(r.fallback).toBeNull();
      expect(r.reason).toMatch(/no_fallback_available/);
    }
  });

  it('reason string includes the current format for the operator to trace', () => {
    const r = pickFailoverFormat('avatar_talking_head', { heygen: false });
    expect(r.reason).toContain('avatar_talking_head');
  });
});

describe('Polish-20 Commit 4: failoverEventName only routes to ugc.requested', () => {
  it('returns generation/ugc.requested regardless of fallback shape', () => {
    expect(failoverEventName('avatar_talking_head')).toBe('generation/ugc.requested');
  });
});

describe('Polish-4: buildAllProvidersFailedMessage', () => {
  it('includes the job id + a run URL for the operator to click', () => {
    const msg = buildAllProvidersFailedMessage('job_abc');
    expect(msg).toContain('job_abc');
    expect(msg).toContain('/runs/job_abc');
    expect(msg).toContain('/connections/ai-provider');
  });
});
