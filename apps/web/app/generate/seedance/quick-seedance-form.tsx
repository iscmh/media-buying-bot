'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CostPreviewBadge } from '@/components/credits/cost-preview-badge';
import { startSeedanceGeneration } from './actions';

/**
 * Polish-29.0.7 Commit 116: user-facing Quick Seedance form.
 *
 * Zero BYOK keys required — credits-only. The CostPreviewBadge from
 * Commit 113 renders inline next to Generate and turns red if the
 * balance is short so the user sees the ask before submitting.
 */
export function QuickSeedanceForm({ initialBalance }: { initialBalance: number }) {
  const router = useRouter();
  const [prompt, setPrompt] = React.useState('');
  const [aspectRatio, setAspectRatio] = React.useState<'9:16' | '1:1' | '16:9'>('9:16');
  const [durationSeconds, setDurationSeconds] = React.useState<5 | 8>(5);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!prompt.trim()) {
      setError('Prompt is required.');
      return;
    }
    setPending(true);
    try {
      const result = await startSeedanceGeneration({
        prompt,
        aspectRatio,
        durationSeconds,
      });
      if (!result.ok) {
        setError(result.errorMessage ?? 'Failed to start the generation.');
        return;
      }
      if (result.runHref) {
        router.push(result.runHref);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('NEXT_REDIRECT')) {
        setError(message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="prompt">Prompt</Label>
        <Textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="A cinematic 5-second product hero shot: gleaming skincare bottle on a marble countertop, morning light through a window, subtle steam rising, shallow depth of field."
          className="font-normal"
        />
        <div className="text-fg-muted flex justify-between text-xs">
          <span>
            Describe the video you want in one prompt. Seedance 2.5 handles it end-to-end.
          </span>
          <span className="tabular-nums">{prompt.length} / 2000</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="space-y-2 sm:col-span-2">
          <Label>Aspect ratio</Label>
          <div className="flex gap-2">
            {(['9:16', '1:1', '16:9'] as const).map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => setAspectRatio(ratio)}
                className={
                  'flex-1 rounded-md border px-3 py-2 text-sm transition ' +
                  (aspectRatio === ratio
                    ? 'border-fg bg-bg-surface text-fg'
                    : 'border-border text-fg-muted hover:border-fg-muted hover:text-fg')
                }
              >
                {ratio}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label>Duration</Label>
          <div className="flex gap-2">
            {([5, 8] as const).map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => setDurationSeconds(sec)}
                className={
                  'flex-1 rounded-md border px-3 py-2 text-sm transition ' +
                  (durationSeconds === sec
                    ? 'border-fg bg-bg-surface text-fg'
                    : 'border-border text-fg-muted hover:border-fg-muted hover:text-fg')
                }
              >
                {sec}s
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button type="submit" disabled={pending || !prompt.trim()}>
          {pending ? 'Starting…' : 'Generate video'}
        </Button>
        <CostPreviewBadge modelId="seedance-2-5-ugc" balance={initialBalance} />
        <span className="text-fg-muted ml-auto text-xs">
          Credits are reserved when you click Generate and refunded automatically if the generation
          fails.
        </span>
      </div>
    </form>
  );
}
