'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_VARIANTS_PER_JOB,
  estimateGenerationCost,
  labelForProvider,
  type ConceptType,
  type UgcVideoProvider,
} from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createGenerationJobAction } from './actions';

interface Props {
  conceptId: string;
  conceptType: ConceptType;
  spentTodayUsd: number;
  capUsd: number;
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

const UGC_PROVIDERS: Array<{ value: UgcVideoProvider; recommended?: boolean }> = [
  { value: 'kie_ai', recommended: true },
  { value: 'heygen' },
  { value: 'arcads' },
];

export function GenerationRequestForm({ conceptId, conceptType, spentTodayUsd, capUsd }: Props) {
  const router = useRouter();
  const [intensity, setIntensity] = React.useState<'small' | 'medium' | 'big'>('medium');
  const [variantCount, setVariantCount] = React.useState<number>(10);
  const [provider, setProvider] = React.useState<UgcVideoProvider>('kie_ai');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const estimate = React.useMemo(
    () =>
      estimateGenerationCost({
        conceptType,
        variantCount: Math.max(1, Math.min(MAX_VARIANTS_PER_JOB, variantCount || 1)),
        provider: conceptType === 'ugc' ? provider : undefined,
      }),
    [conceptType, variantCount, provider],
  );

  const remaining = Math.max(0, capUsd - spentTodayUsd);
  const overCap = estimate.estimateUsd > remaining;
  const overVariantCap = variantCount > MAX_VARIANTS_PER_JOB;
  const usedPct = capUsd > 0 ? Math.round((spentTodayUsd / capUsd) * 100) : 0;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (overCap || overVariantCap) return;
    const formData = new FormData();
    formData.set('conceptId', conceptId);
    formData.set('intensity', intensity);
    formData.set('variantCount', String(variantCount));
    if (conceptType === 'ugc') formData.set('provider', provider);

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

  return (
    <form onSubmit={onSubmit} className="space-y-6">
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

      {/* Provider (UGC only) */}
      {conceptType === 'ugc' && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Video provider</legend>
          {UGC_PROVIDERS.map((p) => (
            <label
              key={p.value}
              className={
                'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ' +
                (provider === p.value
                  ? 'border-primary bg-primary/5'
                  : 'bg-card hover:bg-accent/30')
              }
            >
              <input
                type="radio"
                name="provider"
                value={p.value}
                checked={provider === p.value}
                onChange={() => setProvider(p.value)}
                className="mt-1 h-4 w-4"
              />
              <span className="flex-1">
                <span className="block font-semibold">
                  {labelForProvider(p.value)}{' '}
                  {p.recommended && (
                    <span className="text-muted-foreground text-xs font-normal">· recommended</span>
                  )}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
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
          : `Generate ${variantCount} variants ($${estimate.estimateUsd.toFixed(2)})`}
      </Button>
    </form>
  );
}
