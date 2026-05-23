/**
 * Polish-4: pure failover decision tree. Locks the branches:
 *   cinematic_voiceover + heygen connected      → fallback heygen
 *   cinematic_voiceover + heygen NOT connected  → no fallback
 *   avatar_talking_head + kling+11labs ready    → fallback cinematic
 *   avatar_talking_head + cinematic incomplete  → no fallback
 *   unknown format                              → no fallback
 *
 * Plus event-name mapping + Telegram message shape.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAllProvidersFailedMessage,
  failoverEventName,
  pickFailoverFormat,
} from '../src/lib/failover';

describe('Polish-4: pickFailoverFormat', () => {
  it('cinematic_voiceover with heygen connected → fall back to avatar', () => {
    const d = pickFailoverFormat('cinematic_voiceover', {
      heygen: true,
      klingAndElevenLabs: true,
    });
    expect(d.fallback).toBe('avatar_talking_head');
    expect(d.reason).toMatch(/kling_failed/);
  });

  it('cinematic_voiceover with NO heygen → no fallback', () => {
    const d = pickFailoverFormat('cinematic_voiceover', {
      heygen: false,
      klingAndElevenLabs: true,
    });
    expect(d.fallback).toBeNull();
    expect(d.reason).toMatch(/no_heygen_fallback/);
  });

  it('avatar_talking_head with kling+11labs connected → fall back to cinematic', () => {
    const d = pickFailoverFormat('avatar_talking_head', {
      heygen: true,
      klingAndElevenLabs: true,
    });
    expect(d.fallback).toBe('cinematic_voiceover');
    expect(d.reason).toMatch(/heygen_failed/);
  });

  it('avatar_talking_head with only kling (no elevenlabs) → no fallback', () => {
    const d = pickFailoverFormat('avatar_talking_head', {
      heygen: true,
      klingAndElevenLabs: false,
    });
    expect(d.fallback).toBeNull();
    expect(d.reason).toMatch(/no_cinematic_fallback/);
  });

  it('avatar_talking_head with neither alternative → no fallback', () => {
    const d = pickFailoverFormat('avatar_talking_head', {
      heygen: true,
      klingAndElevenLabs: false,
    });
    expect(d.fallback).toBeNull();
  });

  it('unknown format → no fallback + diagnostic reason', () => {
    const d = pickFailoverFormat('martian_holograms', {
      heygen: true,
      klingAndElevenLabs: true,
    });
    expect(d.fallback).toBeNull();
    expect(d.reason).toMatch(/unknown_format/);
  });
});

describe('Polish-4: failoverEventName', () => {
  it('maps avatar_talking_head to ugc.requested', () => {
    expect(failoverEventName('avatar_talking_head')).toBe('generation/ugc.requested');
  });
  it('maps cinematic_voiceover to cinematic.requested', () => {
    expect(failoverEventName('cinematic_voiceover')).toBe('generation/cinematic.requested');
  });
});

describe('Polish-4: buildAllProvidersFailedMessage', () => {
  it('embeds the job link + points at /connections/ai-provider', () => {
    const m = buildAllProvidersFailedMessage('job_xyz');
    expect(m).toMatch(/\/jobs\/job_xyz/);
    expect(m).toMatch(/\/connections\/ai-provider/);
    expect(m).toMatch(/All connected providers failed/i);
  });
});
