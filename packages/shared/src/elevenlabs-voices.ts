/**
 * Polish-19: a small, hand-curated catalog of ElevenLabs default-library
 * voices the UI can offer in the generation form's Advanced disclosure.
 *
 * Why hand-curated (vs. live-fetching from ElevenLabs):
 *   - The default-library voices below have been stable on ElevenLabs
 *     for years; the IDs are the canonical public identifiers.
 *   - Live-fetching couples the form to a network round-trip per
 *     page-load, requires a valid key already connected, and surfaces
 *     hundreds of community voices that aren't relevant for ad voiceover.
 *   - The kie.ai Kling Avatar pipeline only sends `voice_id` to
 *     ElevenLabs — it doesn't care about voice metadata. A short menu
 *     of recognizable names is enough for the picker.
 *
 * If a user wants a voice not on this list, that's Polish-19.1
 * territory (custom voice picker driven by GET /v1/voices on the
 * user's key, behind a "Choose another voice" disclosure).
 *
 * RACHEL = the existing getDefaultElevenLabsVoiceId() default — kept
 * first in the list so the picker's first option matches the worker's
 * fallback when nothing is chosen.
 */

export interface ElevenLabsVoice {
  /** ElevenLabs voice id — the path parameter in /v1/text-to-speech/{voice_id}. */
  id: string;
  /** Display name as ElevenLabs lists it in their default library. */
  label: string;
  gender: 'female' | 'male';
  /** Accent label — keeps the picker readable without an extra column. */
  accent: 'American' | 'British';
  /** One-line tone descriptor for the picker subtext. */
  description: string;
}

export const ELEVENLABS_DEFAULT_VOICES: ElevenLabsVoice[] = [
  {
    id: '21m00Tcm4TlvDq8ikWAM',
    label: 'Rachel',
    gender: 'female',
    accent: 'American',
    description: 'Warm, conversational — default',
  },
  {
    id: 'pNInz6obpgDQGcFmaJgB',
    label: 'Adam',
    gender: 'male',
    accent: 'American',
    description: 'Deep, professional',
  },
  {
    id: 'EXAVITQu4vr4xnSDxMaL',
    label: 'Bella',
    gender: 'female',
    accent: 'American',
    description: 'Soft, friendly',
  },
  {
    id: 'ErXwobaYiN019PkySvjV',
    label: 'Antoni',
    gender: 'male',
    accent: 'American',
    description: 'Calm, narrative',
  },
];

/** The voice the picker should pre-select. Matches the client's hardcoded fallback. */
export const DEFAULT_ELEVENLABS_VOICE_ID = ELEVENLABS_DEFAULT_VOICES[0]!.id;

export function findElevenLabsVoiceById(id: string): ElevenLabsVoice | undefined {
  return ELEVENLABS_DEFAULT_VOICES.find((v) => v.id === id);
}

/**
 * Pick a voice safely — falls back to the default when the supplied id
 * doesn't exist in the catalog (a user might paste an id from outside
 * the curated list; the worker will still send it through to ElevenLabs,
 * but the picker should show *something* in the menu).
 */
export function resolveElevenLabsVoice(id: string | null | undefined): ElevenLabsVoice {
  if (id) {
    const found = findElevenLabsVoiceById(id);
    if (found) return found;
  }
  return ELEVENLABS_DEFAULT_VOICES[0]!;
}
