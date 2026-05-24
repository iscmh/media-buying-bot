'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_VARIANTS_PER_JOB,
  estimateGenerationCost,
  type ConceptType,
  type CreativeFormat,
  type PipelineType,
} from '@mbb/shared';
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
import {
  type ConnectedProviders,
  type DetectAndRouteResult,
  createGenerationJobAction,
  detectAndRouteAction,
} from './actions';

interface Props {
  conceptId: string;
  conceptType: ConceptType;
  spentTodayUsd: number;
  capUsd: number;
  liveAcknowledged: boolean;
  /** Polish-4: drives the provider + format pickers. */
  connectedProviders: ConnectedProviders;
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

/**
 * Generation request form. Polish-3: mock-mode toggle retired — every
 * submission goes live. First-time users still hit the spend-
 * acknowledgment dialog; subsequent submits skip it. Server action
 * (createGenerationJobAction) defaults to mode='live' too — see
 * actions.ts for the dev/CLI mock back door.
 */
export function GenerationRequestForm({
  conceptId,
  conceptType,
  spentTodayUsd,
  capUsd,
  liveAcknowledged: initialLiveAck,
  connectedProviders,
}: Props) {
  const router = useRouter();
  const [intensity, setIntensity] = React.useState<'small' | 'medium' | 'big'>('medium');
  const [variantCount, setVariantCount] = React.useState<number>(10);
  const [liveAck, setLiveAck] = React.useState(initialLiveAck);
  const [showLiveDialog, setShowLiveDialog] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Polish-6: auto-detect creative format + pipeline.
  const [detection, setDetection] = React.useState<DetectAndRouteResult | null>(null);
  const [detecting, setDetecting] = React.useState(false);
  const detectedPipeline = detection?.pipeline as PipelineType | undefined;

  const heygenReady = connectedProviders.heygen.connected;
  const format: CreativeFormat = 'avatar_talking_head';

  const estimate = React.useMemo(
    () =>
      estimateGenerationCost({
        conceptType,
        variantCount: Math.max(1, Math.min(MAX_VARIANTS_PER_JOB, variantCount || 1)),
        provider: conceptType === 'ugc' ? 'heygen' : undefined,
        format: conceptType === 'ugc' ? format : undefined,
        pipeline: detectedPipeline,
      }),
    [conceptType, variantCount, format, detectedPipeline],
  );

  async function handleReferenceUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setDetecting(true);
    setDetection(null);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), ''));
      const result = await detectAndRouteAction(base64, file.type);
      setDetection(result);
      if (!result.ok && result.errorMessage) setError(result.errorMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detection failed.');
    } finally {
      setDetecting(false);
    }
  }

  const remaining = Math.max(0, capUsd - spentTodayUsd);
  const overCap = estimate.estimateUsd > remaining;
  const overVariantCap = variantCount > MAX_VARIANTS_PER_JOB;
  const usedPct = capUsd > 0 ? Math.round((spentTodayUsd / capUsd) * 100) : 0;

  function performSubmit() {
    if (overCap || overVariantCap) return;
    const formData = new FormData();
    formData.set('conceptId', conceptId);
    formData.set('intensity', intensity);
    formData.set('variantCount', String(variantCount));
    // mode defaults to 'live' server-side; explicit for log clarity.
    formData.set('mode', 'live');
    formData.set('format', format);
    if (detectedPipeline) formData.set('pipeline', detectedPipeline);

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

  async function confirmLiveDialog() {
    setError(null);
    const result = await acknowledgeLiveGenerationAction();
    if (!result.ok) {
      setError(result.errorMessage ?? 'Could not record acknowledgment.');
      return;
    }
    setLiveAck(true);
    setShowLiveDialog(false);
    performSubmit();
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!liveAck) {
      setShowLiveDialog(true);
      return;
    }
    performSubmit();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Intensity */}
      <fieldset className="space-y-3">
        <legend className="text-fg text-sm font-medium">Intensity</legend>
        {INTENSITIES.map((opt) => (
          <label
            key={opt.value}
            className={
              'flex cursor-pointer items-start gap-3 rounded-md border p-4 transition-colors ' +
              (intensity === opt.value
                ? 'border-fg-muted bg-bg-hover'
                : 'bg-bg-elevated hover:bg-bg-hover')
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
              <span className="text-fg block font-medium">{opt.label}</span>
              <span className="text-fg-muted block text-sm">{opt.description}</span>
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
          className="font-mono"
        />
        <p className="text-fg-muted text-xs">
          1–{MAX_VARIANTS_PER_JOB} per job. More variants = more cost; cost scales linearly.
        </p>
        {overVariantCap && (
          <p className="text-xs text-[color:var(--destructive-color)]">
            Maximum {MAX_VARIANTS_PER_JOB} variants per job.
          </p>
        )}
      </div>

      {/* Polish-6: Reference creative upload + auto-detection. */}
      {conceptType === 'ugc' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="referenceCreative">Reference creative (optional)</Label>
            <Input
              id="referenceCreative"
              type="file"
              accept="video/*,image/*"
              onChange={handleReferenceUpload}
              disabled={detecting}
            />
            <p className="text-fg-muted text-xs">
              Upload a winning ad. The bot auto-detects format and picks the best pipeline.
            </p>
          </div>
          {detecting && (
            <div className="bg-bg-elevated text-fg-muted rounded-md border p-3 text-sm">
              Analyzing creative...
            </div>
          )}
          {detection?.ok && detection.detection && (
            <div className="bg-bg-elevated space-y-1.5 rounded-md border p-3 text-sm">
              <p>
                <span className="text-fg-muted">Detected: </span>
                <span className="text-fg font-mono font-medium">
                  {detection.detection.format.replace(/_/g, ' ')}
                </span>
              </p>
              {detection.pipeline && (
                <p>
                  <span className="text-fg-muted">Pipeline: </span>
                  <span className="text-fg font-mono font-medium">{detection.pipelineLabel}</span>
                </p>
              )}
              {detection.detection.demographics?.gender && (
                <p className="text-fg-muted text-xs">
                  {detection.detection.demographics.gender}
                  {detection.detection.demographics.ageRange
                    ? `, ${detection.detection.demographics.ageRange}`
                    : ''}
                </p>
              )}
              {detection.errorMessage && !detection.pipeline && (
                <p className="text-xs text-[color:var(--destructive-color)]">
                  {detection.errorMessage}
                </p>
              )}
            </div>
          )}
          {!detection && !detecting && (
            <p className="text-fg-muted text-xs">
              No reference? Default: {heygenReady ? 'HeyGen Avatar Mode' : 'auto-pick on submit'}.
            </p>
          )}
        </div>
      )}

      {/* Cost estimator */}
      <div className="bg-bg-elevated space-y-2 rounded-md border p-4 text-sm">
        <p className="text-fg font-medium">
          Estimated cost: <span className="font-mono">${estimate.estimateUsd.toFixed(2)}</span>
        </p>
        <ul className="text-fg-muted space-y-0.5 text-xs">
          {estimate.breakdown.map((b, i) => (
            <li key={i} className="flex justify-between">
              <span>{b.item}</span>
              <span className="font-mono">${b.cost.toFixed(2)}</span>
            </li>
          ))}
        </ul>
        <hr className="border-border my-2" />
        <p className="text-fg-muted text-xs">
          Daily cap: <span className="text-fg font-mono">${capUsd.toFixed(2)}</span> · used{' '}
          <span className="text-fg font-mono">${spentTodayUsd.toFixed(2)}</span> ({usedPct}%) ·
          remaining <span className="text-fg font-mono">${remaining.toFixed(2)}</span>
        </p>
        {overCap && (
          <p className="text-xs text-[color:var(--destructive-color)]">
            This job would exceed your remaining daily cap. Reduce variant count or wait for the cap
            to reset.
          </p>
        )}
      </div>

      {error && (
        <p className="text-sm text-[color:var(--destructive-color)]" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending || overCap || overVariantCap}>
          {pending
            ? 'Creating job…'
            : `Generate ${variantCount} variants · $${estimate.estimateUsd.toFixed(2)}`}
        </Button>
      </div>

      {conceptType === 'ugc' && !heygenReady && !connectedProviders.kling.connected && (
        <p className="text-xs text-[color:var(--destructive-color)]">
          Connect at least one provider on{' '}
          <a className="underline" href="/connections/ai-provider">
            /connections/ai-provider
          </a>{' '}
          before generating.
        </p>
      )}

      {/* First-time spend confirmation dialog. */}
      <Dialog open={showLiveDialog} onOpenChange={setShowLiveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Real spend ahead</DialogTitle>
            <DialogDescription>
              This generation uses your connected API keys (Gemini, Claude, and HeyGen for UGC) and
              spends real money. You can monitor your daily AI spend in settings.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-bg-elevated space-y-1 rounded-md border p-3 text-sm">
            <p>
              Estimated cost: <span className="font-mono">${estimate.estimateUsd.toFixed(2)}</span>
            </p>
            <p className="text-fg-muted text-xs">
              Daily cap: <span className="font-mono">${capUsd.toFixed(2)}</span> · used{' '}
              <span className="font-mono">${spentTodayUsd.toFixed(2)}</span> · remaining{' '}
              <span className="font-mono">${remaining.toFixed(2)}</span>
            </p>
          </div>
          <p className="text-fg-muted text-xs">
            Future submissions skip this dialog. You can revoke API keys anytime from Connections.
          </p>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={confirmLiveDialog} disabled={pending}>
              I understand, generate
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}
