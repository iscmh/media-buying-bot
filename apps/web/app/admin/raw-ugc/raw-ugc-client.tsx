'use client';

import * as React from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  checkRawUgcStatusAction,
  submitRawUgcAction,
  type CheckRawUgcResult,
  type SubmitRawUgcInput,
  type SubmitRawUgcResult,
} from './actions';

/**
 * Polish-30.0.15 Commit 187: admin-only raw UGC generator client UI.
 *
 * Flow: fill persona (gender/age/ethnicity/look) + script, submit,
 * poll every ~5s until status flips to completed, show the mp4 with
 * a download button. Zero DB persistence — this is a scratchpad.
 */

type JobState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'polling'; videoId: string; voiceName?: string; attempts: number }
  | { kind: 'completed'; videoId: string; voiceName?: string; videoUrl: string }
  | { kind: 'failed'; errorMessage: string };

const AGE_BUCKETS = ['20s', '30s', '40s', '50s', '60s', '70s'] as const;
const ETHNICITIES = ['white', 'black', 'hispanic', 'asian', 'middle_eastern', 'mixed'] as const;

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 264; // 22 min at 5s each — matches worker ceiling

export function RawUgcClient() {
  const [gender, setGender] = React.useState<'male' | 'female'>('female');
  const [ageRange, setAgeRange] = React.useState<string>('30s');
  const [ethnicity, setEthnicity] = React.useState<string>('white');
  const [look, setLook] = React.useState<string>(
    'Shoulder-length brown hair, light makeup, white t-shirt, soft natural daylight from a window, warm friendly expression, filmed on an iPhone front camera in a plain bedroom.',
  );
  const [script, setScript] = React.useState<string>('');
  const [state, setState] = React.useState<JobState>({ kind: 'idle' });

  const canSubmit = state.kind === 'idle' || state.kind === 'completed' || state.kind === 'failed';

  async function handleSubmit() {
    if (!look.trim() || !script.trim()) return;
    setState({ kind: 'submitting' });
    const input: SubmitRawUgcInput = {
      gender,
      ageRange,
      ethnicity,
      look: look.trim(),
      script: script.trim(),
    };
    let submitResult: SubmitRawUgcResult;
    try {
      submitResult = await submitRawUgcAction(input);
    } catch (err) {
      setState({
        kind: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!submitResult.ok || !submitResult.videoId) {
      setState({
        kind: 'failed',
        errorMessage: submitResult.errorMessage ?? 'Submit returned not-ok',
      });
      return;
    }
    setState({
      kind: 'polling',
      videoId: submitResult.videoId,
      voiceName: submitResult.voiceName,
      attempts: 0,
    });
  }

  // Polling loop
  React.useEffect(() => {
    if (state.kind !== 'polling') return;
    if (state.attempts >= POLL_MAX_ATTEMPTS) {
      setState({
        kind: 'failed',
        errorMessage: `Timed out after ${((POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 60000).toFixed(0)} min`,
      });
      return;
    }
    const timer = setTimeout(async () => {
      let r: CheckRawUgcResult;
      try {
        r = await checkRawUgcStatusAction(state.videoId);
      } catch (err) {
        setState({
          kind: 'failed',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!r.ok || r.status === 'failed') {
        setState({
          kind: 'failed',
          errorMessage: r.errorMessage ?? 'Status returned failed',
        });
        return;
      }
      if (r.status === 'completed' && r.videoUrl) {
        setState({
          kind: 'completed',
          videoId: state.videoId,
          voiceName: state.voiceName,
          videoUrl: r.videoUrl,
        });
        return;
      }
      // still processing
      setState({
        kind: 'polling',
        videoId: state.videoId,
        voiceName: state.voiceName,
        attempts: state.attempts + 1,
      });
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <div className="space-y-6">
      {/* Persona form */}
      <section className="border-border bg-bg-surface rounded-md border p-4">
        <h2 className="text-fg mb-4 text-sm font-semibold">Persona</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="text-fg-subtle mb-1 block text-xs font-medium uppercase tracking-wider">
              Gender
            </label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as 'male' | 'female')}
              disabled={!canSubmit}
              className="border-border bg-bg text-fg w-full rounded border px-3 py-2 text-sm"
            >
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>
          <div>
            <label className="text-fg-subtle mb-1 block text-xs font-medium uppercase tracking-wider">
              Age range
            </label>
            <select
              value={ageRange}
              onChange={(e) => setAgeRange(e.target.value)}
              disabled={!canSubmit}
              className="border-border bg-bg text-fg w-full rounded border px-3 py-2 text-sm"
            >
              {AGE_BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-fg-subtle mb-1 block text-xs font-medium uppercase tracking-wider">
              Ethnicity
            </label>
            <select
              value={ethnicity}
              onChange={(e) => setEthnicity(e.target.value)}
              disabled={!canSubmit}
              className="border-border bg-bg text-fg w-full rounded border px-3 py-2 text-sm"
            >
              {ETHNICITIES.map((e) => (
                <option key={e} value={e}>
                  {e.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3">
          <label className="text-fg-subtle mb-1 block text-xs font-medium uppercase tracking-wider">
            Look description
          </label>
          <textarea
            value={look}
            onChange={(e) => setLook(e.target.value)}
            disabled={!canSubmit}
            rows={3}
            className="border-border bg-bg text-fg w-full rounded border px-3 py-2 text-sm"
            placeholder="Hair, wardrobe, expression, lighting, setting — anything visual."
          />
          <p className="text-fg-subtle mt-1 text-[11px]">
            Nano Banana Pro renders this as the character still. Describe hair, wardrobe, lighting,
            setting. Don't include gender/age/ethnicity words here — those live in the dropdowns
            above.
          </p>
        </div>
      </section>

      {/* Script */}
      <section className="border-border bg-bg-surface rounded-md border p-4">
        <h2 className="text-fg mb-4 text-sm font-semibold">Script</h2>
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          disabled={!canSubmit}
          rows={10}
          className="border-border bg-bg text-fg w-full rounded border px-3 py-2 font-mono text-sm leading-relaxed"
          placeholder={
            'Okay so Im not gonna lie, I didnt think this was gonna work. Like at all. But three weeks in? Bro. The energy. The focus...'
          }
        />
        <p className="text-fg-subtle mt-1 text-[11px]">
          First-person monologue. HeyGen Avatar IV TTS reads this literally — write the way the
          person would actually say it on their phone. Up to ~2500 chars (HeyGen caps at 180 sec).
        </p>
      </section>

      {/* Submit */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="accent"
          size="lg"
          onClick={handleSubmit}
          disabled={!canSubmit || !look.trim() || !script.trim()}
        >
          {state.kind === 'submitting'
            ? 'Submitting…'
            : state.kind === 'polling'
              ? 'Rendering…'
              : state.kind === 'completed'
                ? 'Generate another'
                : 'Generate'}
        </Button>
        {state.kind === 'polling' && (
          <div className="text-fg-muted flex items-center gap-2 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            Poll #{state.attempts + 1} · HeyGen Avatar IV renders take 10-22 min typically
            {state.voiceName && ` · voice: ${state.voiceName}`}
          </div>
        )}
        {state.kind === 'submitting' && (
          <div className="text-fg-muted flex items-center gap-2 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            Nano Banana char → HeyGen upload → voice match → submit
          </div>
        )}
      </div>

      {state.kind === 'failed' && (
        <div className="border-[color:var(--accent-negative)]/40 bg-[color:var(--accent-negative)]/10 text-fg rounded-md border px-3 py-2 text-sm">
          <strong>Failed:</strong> {state.errorMessage}
        </div>
      )}

      {state.kind === 'completed' && (
        <section className="border-border bg-bg-surface rounded-md border p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-fg text-sm font-semibold">Done</h2>
              {state.voiceName && <p className="text-fg-muted text-xs">voice: {state.voiceName}</p>}
            </div>
            <a
              href={state.videoUrl}
              download
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs',
                'border-border text-fg-muted hover:border-fg/50 hover:text-fg transition-colors',
              )}
            >
              <Download className="h-3 w-3" />
              Download mp4
            </a>
          </div>
          <video
            src={state.videoUrl}
            controls
            playsInline
            className="bg-bg-inset mt-3 block max-h-[600px] w-full rounded object-contain"
          />
        </section>
      )}
    </div>
  );
}
