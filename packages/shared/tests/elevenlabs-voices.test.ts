/**
 * Polish-19 Commit 2: voice catalog invariants. The catalog is
 * hand-curated, so the tests guard against accidental ID duplication,
 * a default that drifts out of the list, and the canonical Rachel ID
 * staying first (so the picker's default-selected option matches the
 * worker's default voice).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ELEVENLABS_DEFAULT_VOICES,
  findElevenLabsVoiceById,
  resolveElevenLabsVoice,
} from '../src';

describe('Polish-19: ElevenLabs voice catalog', () => {
  it('has at least two voices and a mix of genders', () => {
    expect(ELEVENLABS_DEFAULT_VOICES.length).toBeGreaterThanOrEqual(2);
    const genders = new Set(ELEVENLABS_DEFAULT_VOICES.map((v) => v.gender));
    expect(genders.has('female')).toBe(true);
    expect(genders.has('male')).toBe(true);
  });

  it('has unique voice IDs', () => {
    const ids = ELEVENLABS_DEFAULT_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique display labels (no two Bellas)', () => {
    const labels = ELEVENLABS_DEFAULT_VOICES.map((v) => v.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every voice has non-empty fields the picker depends on', () => {
    for (const v of ELEVENLABS_DEFAULT_VOICES) {
      expect(v.id.length).toBeGreaterThan(0);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
    }
  });

  it('Rachel (canonical default) is the FIRST entry', () => {
    // Picker selects voices[0] when no voice is supplied; this assertion
    // pins the order so a future re-sort doesn't silently change the
    // default the operator sees.
    expect(ELEVENLABS_DEFAULT_VOICES[0]!.label).toBe('Rachel');
    expect(ELEVENLABS_DEFAULT_VOICES[0]!.id).toBe('21m00Tcm4TlvDq8ikWAM');
  });

  it('DEFAULT_ELEVENLABS_VOICE_ID matches the elevenlabs client default', () => {
    // The elevenlabs client hardcodes '21m00Tcm4TlvDq8ikWAM' (Rachel).
    // The picker's default and the worker's fallback must agree, else
    // a user who never opens the picker sees Rachel in the UI but the
    // worker silently routes to whatever the client defaulted to.
    expect(DEFAULT_ELEVENLABS_VOICE_ID).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(findElevenLabsVoiceById(DEFAULT_ELEVENLABS_VOICE_ID)).toBeDefined();
  });
});

describe('Polish-19: findElevenLabsVoiceById', () => {
  it('returns the entry for a known voice', () => {
    const v = findElevenLabsVoiceById('pNInz6obpgDQGcFmaJgB');
    expect(v?.label).toBe('Adam');
  });

  it('returns undefined for an unknown id', () => {
    expect(findElevenLabsVoiceById('not_a_real_id')).toBeUndefined();
    expect(findElevenLabsVoiceById('')).toBeUndefined();
  });
});

describe('Polish-19: resolveElevenLabsVoice', () => {
  it('returns the matching entry when id is known', () => {
    expect(resolveElevenLabsVoice('EXAVITQu4vr4xnSDxMaL').label).toBe('Bella');
  });

  it('falls back to default for null / undefined / empty / unknown', () => {
    const def = resolveElevenLabsVoice(null);
    expect(def.id).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
    expect(resolveElevenLabsVoice(undefined).id).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
    expect(resolveElevenLabsVoice('').id).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
    expect(resolveElevenLabsVoice('unknown_id_xyz').id).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
  });
});
