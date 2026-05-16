'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { MAX_VARIANTS_PER_JOB, estimateGenerationCost, type ConceptType } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { acknowledgeLiveGenerationAction } from './ack-action';
import { createGenerationJobAction } from './actions';

interface Props {
  conceptId: string;
  conceptType: ConceptType;
  spentTodayUsd: number;
  capUsd: number;
  liveAcknowledged: boolean;
}

const INTENSITIES: Array<{
  value: 'small' | 'medium' | 'big';
  label: string;
  description: string;
}> = [
  {
    value: 'small',
    label: 'Small',
    description: 'Same persona, same script, 1–2 word swaps. Cheapest, lowest variance.',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Same persona, similar structure, different proof points.',
  },
  {
    value: 'big',
    label: 'Big',
    description: 'Different persona, fresh angle, same offer. Highest variance.',
  },
];

export function GenerationRequestForm({
  conceptId,
  conceptType,
  spentTodayUsd,
  capUsd,
  liveAcknowledged: initialLiveAck,
}: Props) {
  const router = useRouter();
  const [intensity, setIntensity] = React.useState<'small' | 'medium' | 'big'>('medium');
  const [variantCount, setVariantCount] = React.useState<number>(10);
  // Phase 3f: UGC always uses HeyGen Avatar Mode. Provider picker
  // retired — the form just submits without a provider field and the
  // server action auto-picks 'heygen' for ugc concepts.
  const [mode, setMode] = React.useState<'mock' | 'live'>('mock');
  const [liveAck, setLiveAck] = React.useState(initialLiveAck);
  const [showLiveDialog, setShowLiveDialog] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const estimate = React.useMemo(
    () =>
      estimateGenerationCost({
        conceptType,
        variantCount: Math.max(1, Math.min(MAX_VARIANTS_PER_JOB, variantCount || 1)),
        provider: conceptType === 'ugc' ? 'heygen' : undefined,
      }),
    [conceptType, variantCount],
  );

  const remaining = Math.max(0, capUsd - spentTodayUsd);
  const overCap = estimate.estimateUsd > remaining;
  const overVariantCap = variantCount > MAX_VARIANTS_PER_JOB;
  const usedPct = capUsd > 0 ? Math.round((spentTodayUsd / capUsd) * 100) : 0;

  function pickMode(next: 'mock' | 'live') {
    if (next === 'live' && !liveAck) {
      setShowLiveDialog(true);
      return;
    }
    setMode(next);
  }

  async function confirmLiveDialog() {
    setError(null);
    const result = await acknowledgeLiveGenerationAction();
    if (!result.ok) {
      setError(result.errorMessage ?? 'Could not record acknowledgment.');
      return;
    }
    setLiveAck(true);
    setMode('live');
    setShowLiveDialog(false);
  }

  function submit() {
    if (overCap || overVariantCap) return;
    const formData = new FormData();
    formData.set('conceptId', conceptId);
    formData.set('intensity', intensity);
    formData.set('variantCount', String(variantCount));
    formData.set('mode', mode);
    // Provider field omitted intentionally — server action auto-picks
    // 'heygen' for ugc concepts (Phase 3f).

    startTransition(async () => {
      setError(null);
      const result = await createGenerationJobAction(formData);
      if (!result.ok || !result.jobId) {
        setError(result.errorMessage ?? 'Could not create generation job.');
        return;
      }
      router.push(`/jobs/${result.jobId}`);
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Mode toggle (Phase 3b) */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Mode</legend>
        <div className="bg-card flex gap-2 rounded-lg border p-2">
          <button
            type="button"
            onClick={() => pickMode('mock')}
            className={
              'flex-1 rounded-md px-3 py-2 text-sm transition-colors ' +
              (mode === 'mock' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent/30')
            }
          >
            <span className="block font-semibold">Mock</span>
            <span className="text-xs opacity-80">Free placeholder data</span>
          </button>
          <button
            type="button"
            onClick={() => pickMode('live')}
            className={
              'flex-1 rounded-md px-3 py-2 text-sm transition-colors ' +
              (mode === 'live' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent/30')
            }
          >
            <span className="block font-semibold">Live</span>
            <span className="text-xs opacity-80">Real spend on your API keys</span>
          </button>
        </div>
        {mode === 'live' && (
          <p className="text-xs text-amber-700">
            Live mode will spend real money on your connected provider keys.
          </p>
        )}
      </fieldset>

      {/* Intensity */}
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Intensity</legend>
        {INTENSITIES.map((opt) => (
          <label
            key={opt.value}
            className={
              'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ' +
              (intensity === opt.value
                ? 'border-primary bg-primary/5'
                : 'bg-card hover:bg-accent/30')
            }
          >
            <input
              type="radio"
              name="intensity"
              value={opt.value}
              checked={intensity === opt.value}
              onChange={() => setIntensity(opt.value)}
              className="mt-1 h-4 w-4"
            />
            <span>
              <span className="block font-semibold">{opt.label}</span>
              <span className="text-muted-foreground block text-sm">{opt.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* Variant count */}
      <div className="space-y-1.5">
        <Label htmlFor="variantCount">Variant count</Label>
        <Input
          id="variantCount"
          type="number"
          min={1}
          max={MAX_VARIANTS_PER_JOB}
          value={variantCount}
          onChange={(e) => setVariantCount(Math.floor(Number(e.target.value) || 0))}
        />
        <p className="text-muted-foreground text-xs">
          1–{MAX_VARIANTS_PER_JOB} per job. More variants = more cost; cost scales linearly.
        </p>
        {overVariantCap && (
          <p className="text-destructive text-xs">
            Maximum {MAX_VARIANTS_PER_JOB} variants per job.
          </p>
        )}
      </div>

      {/* Video provider note (UGC only) */}
      {conceptType === 'ugc' && (
        <div className="bg-card text-muted-foreground rounded-lg border p-3 text-xs">
          UGC variants use HeyGen Avatar Mode — Claude matches a different avatar to your source
          persona for each variant. Want every variant to use the same avatar instead? Force one in{' '}
          <a className="underline" href="/settings#heygen-avatar">
            Settings → Force Specific Avatar
          </a>
          .
        </div>
      )}

      {/* Cost estimator */}
      <div className="bg-card space-y-2 rounded-lg border p-4 text-sm">
        <p className="font-medium">Estimated cost: ${estimate.estimateUsd.toFixed(2)}</p>
        <ul className="text-muted-foreground space-y-0.5 text-xs">
          {estimate.breakdown.map((b, i) => (
            <li key={i} className="flex justify-between">
              <span>{b.item}</span>
              <span>${b.cost.toFixed(2)}</span>
            </li>
          ))}
        </ul>
        <hr className="my-2" />
        <p className="text-muted-foreground text-xs">
          Daily cap: <strong>${capUsd.toFixed(2)}</strong> · used{' '}
          <strong>${spentTodayUsd.toFixed(2)}</strong> ({usedPct}%) · remaining{' '}
          <strong>${remaining.toFixed(2)}</strong>
        </p>
        {overCap && (
          <p className="text-destructive text-xs">
            This job would exceed your remaining daily cap. Reduce variant count, switch provider,
            or wait for the cap to reset.
          </p>
        )}
      </div>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" disabled={pending || overCap || overVariantCap}>
        {pending
          ? 'Creating job…'
          : mode === 'live'
            ? `Generate live · ${variantCount} variants · $${estimate.estimateUsd.toFixed(2)}`
            : `Generate ${variantCount} variants ($${estimate.estimateUsd.toFixed(2)})`}
      </Button>

      {/* First-time live-mode confirmation dialog (Phase 3b) */}
      <Dialog open={showLiveDialog} onOpenChange={setShowLiveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Live mode — real spend</DialogTitle>
            <DialogDescription>
              This generation will use your connected API keys (Gemini, Claude, and your chosen
              video provider) and spend real money. You can monitor your daily AI spend in settings.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-card space-y-1 rounded-md border p-3 text-sm">
            <p>
              Estimated cost for this job: <strong>${estimate.estimateUsd.toFixed(2)}</strong>
            </p>
            <p>
              Daily cap: <strong>${capUsd.toFixed(2)}</strong> · used{' '}
              <strong>${spentTodayUsd.toFixed(2)}</strong> · remaining{' '}
              <strong>${remaining.toFixed(2)}</strong>
            </p>
          </div>
          <p className="text-muted-foreground text-xs">
            Future live submissions skip this dialog. You can revoke API keys anytime from
            Connections.
          </p>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={confirmLiveDialog}>
              I understand, proceed
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}
