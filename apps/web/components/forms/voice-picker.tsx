'use client';

import * as React from 'react';
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ELEVENLABS_DEFAULT_VOICES,
  resolveElevenLabsVoice,
} from '@mbb/shared';
import { cn } from '@/lib/utils';

interface Props {
  /** Currently selected voice id (controlled). */
  value?: string | null;
  /** Fires with the new voice id. */
  onChange: (voiceId: string) => void;
  /** Hides the label when the picker lives in a labelled fieldset. */
  hideLabel?: boolean;
  className?: string;
  /** Surfaces the picker as disabled during submit. */
  disabled?: boolean;
}

/**
 * Polish-19: ElevenLabs voice picker for the generation form.
 *
 * Sourced from the hand-curated catalog in @mbb/shared rather than a
 * live /v1/voices call — see elevenlabs-voices.ts for the why. The
 * picker is intentionally a native <select> so it composes cleanly
 * inside the existing form layout (matches the NativeSelect pattern
 * already used on /settings) and stays accessible without extra wiring.
 *
 * The currently-selected voice's subtext (gender / accent / tone) is
 * rendered underneath so users can tell Rachel from Bella without
 * opening the dropdown twice.
 */
export function VoicePicker({ value, onChange, hideLabel, className, disabled }: Props) {
  const current = resolveElevenLabsVoice(value ?? DEFAULT_ELEVENLABS_VOICE_ID);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {!hideLabel && (
        <label htmlFor="voice-picker" className="text-fg text-xs font-medium">
          Voice
        </label>
      )}
      <select
        id="voice-picker"
        aria-label="Voice"
        value={current.id}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          'border-input bg-bg-elevated text-fg focus:ring-ring h-9 w-full rounded-md border px-3 text-sm',
          'focus:outline-none focus:ring-2 focus:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {ELEVENLABS_DEFAULT_VOICES.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label} ({v.gender === 'female' ? 'F' : 'M'}, {v.accent})
          </option>
        ))}
      </select>
      <p className="text-fg-muted text-xs">{current.description}</p>
    </div>
  );
}
