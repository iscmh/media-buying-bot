'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { estimateGenerationCost } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { acknowledgeLiveGenerationAction } from './ack-action';
import { createGenerationJobAction, type ConnectedProviders } from './actions';
import {
  SIMPLIFIED_DEFAULT_DURATION_SECONDS,
  SIMPLIFIED_DEFAULT_VARIANTS,
  SIMPLIFIED_MAX_VARIANTS,
  SIMPLIFIED_MIN_VARIANTS,
  VIDEO_MODELS,
  buildSubmissionFormData,
  canSubmitState,
  clampVariantCount,
  formatModelCostHintPerVariant,
  getDefaultProviderForModel,
  isRecommendedTier,
  type SimplifiedFormState,
  type VideoModel,
  type VideoModelId,
} from './simplified-form-helpers';

interface Props {
  conceptId: string;
  /** Optional preview URL — signed Supabase URL for UGC sources, fileUrl for static. */
  sourcePreviewUrl: string | null;
  /** Detected source duration (seconds), if known. Seeds the duration picker via snap. */
  detectedSourceSeconds: number | null;
  /**
   * Polish-20 Commit 1: retained on the props so `kie_ai` connection
   * gates the whole picker (no kie key → no models available), plus
   * for Commit 2's Advanced-form link.
   */
  connectedProviders: ConnectedProviders;
  /** Daily-cap state for the upfront over-cap warning. */
  spentTodayUsd: number;
  capUsd: number;
  /** Has the user already acknowledged the first-time live-spend dialog? */
  liveAcknowledged: boolean;
}

/**
 * Polish-20 → Polish-20.0.1: simplified generation form.
 *
 * MANDATORY model picker at the top (three cards, budget → recommended
 * → premium). Generate stays disabled until the user picks a model.
 * The recommended-tier card carries a subtle accent so the smart
 * default is visually obvious without being auto-selected.
 *
 * Polish-20.0.1: length picker REMOVED. Duration is auto-detected
 * from the source video via the Polish-19.3.1 fallback chain — the
 * simplified form is duration-less. Users who need explicit control
 * open the advanced form at /concepts/[id]/generate/advanced.
 *
 * Cost preview uses the client-detected source duration when
 * available; when detection is still pending the preview shows a
 * "calculated after source analysis" placeholder rather than a
 * misleading $0.
 */
export function SimplifiedGenerationForm({
  conceptId,
  sourcePreviewUrl,
  detectedSourceSeconds,
  connectedProviders,
  spentTodayUsd,
  capUsd,
  liveAcknowledged: initialLiveAck,
}: Props) {
  const router = useRouter();

  // Polish-20: model picker required. Spec: user MUST pick — no default.
  const [modelId, setModelId] = React.useState<VideoModelId | null>(null);
  const [variantCount, setVariantCount] = React.useState<number>(SIMPLIFIED_DEFAULT_VARIANTS);

  const [error, setError] = React.useState<string | null>(null);
  const [liveAck, setLiveAck] = React.useState(initialLiveAck);
  const [showLiveDialog, setShowLiveDialog] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  // Polish-20 Commit 1: at launch every live model is on kie.ai.
  // Default provider comes from the descriptor helper.
  const providerId = modelId ? (getDefaultProviderForModel(modelId)?.id ?? null) : null;

  const state: SimplifiedFormState = {
    modelId,
    providerId,
    variantCount,
  };
  const canSubmit = canSubmitState(state);

  // Polish-20.0.1: cost preview uses the client-detected source
  // duration when available; falls back to the shared default (30s)
  // when detection is still pending. The worker's Polish-19.3.1
  // fallback chain resolves the final target server-side, so this
  // number is a preview only.
  const previewSeconds = detectedSourceSeconds ?? SIMPLIFIED_DEFAULT_DURATION_SECONDS;
  const detectionPending = detectedSourceSeconds == null;
  const estimate = modelId
    ? estimateGenerationCost({
        conceptType: 'ugc',
        variantCount,
        videoModelId: modelId,
        sourceDurationSeconds: previewSeconds,
      })
    : null;

  const remaining = Math.max(0, capUsd - spentTodayUsd);
  const overCap = estimate != null && estimate.estimateUsd > remaining;

  // Polish-20 launch requires the kie.ai BYOK key since every live
  // provider entry maps to it. When the user hasn't connected it, we
  // still render the picker (so they can SEE what they'd get) but
  // disable submission with a clear "connect kie.ai" nudge.
  const hasKieKey = connectedProviders.kie_ai.connected;

  function performSubmit() {
    if (overCap || !canSubmit) return;
    const formData = buildSubmissionFormData({
      conceptId,
      state,
      // Polish-20.0.1: thread the client-detected source duration
      // through as an optional FormData field. The worker still
      // falls back to analyze-concept's vision output when this is
      // absent.
      detectedSourceSeconds,
    });
    startTransition(async () => {
      setError(null);
      const result = await createGenerationJobAction(formData);
      if (!result.ok || !result.jobId) {
        setError(result.errorMessage ?? 'Could not create generation job.');
        return;
      }
      router.push(`/runs/${result.jobId}`);
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
      {/* Source preview */}
      <section className="border-border bg-bg-surface rounded-md border p-4">
        <div className="text-fg-subtle mb-2 text-xs font-semibold uppercase tracking-wider">
          Source
        </div>
        {sourcePreviewUrl ? (
          <div className="flex items-start gap-3">
            <video
              src={sourcePreviewUrl}
              className="bg-bg-inset h-32 w-24 rounded object-cover"
              muted
              playsInline
            />
            <div className="text-fg-muted text-sm">
              <p>Winning ad uploaded.</p>
              {detectedSourceSeconds != null && (
                <p className="text-fg-subtle text-xs">Detected length: {detectedSourceSeconds}s</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-fg-muted text-sm">No source preview available.</p>
        )}
      </section>

      {/* Polish-20: model picker (MANDATORY, top-level, not under Advanced) */}
      <section aria-labelledby="model-picker-heading" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="model-picker-heading" className="text-fg text-sm font-medium">
            Model <span className="text-[color:var(--accent-negative)]">*</span>
          </h2>
          <span className="text-fg-subtle text-xs">Pick a model to continue</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {VIDEO_MODELS.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              picked={modelId === model.id}
              disabled={isPending}
              targetSeconds={previewSeconds}
              onPick={() => setModelId(model.id)}
            />
          ))}
        </div>
      </section>

      {/* Variant count + auto-detected duration indicator */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="variant-count" className="text-fg block text-sm font-medium">
            Generate
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="variant-count"
              type="number"
              min={SIMPLIFIED_MIN_VARIANTS}
              max={SIMPLIFIED_MAX_VARIANTS}
              step={1}
              value={variantCount}
              onChange={(e) => setVariantCount(clampVariantCount(Number(e.target.value)))}
              disabled={isPending}
              className="border-input bg-bg-elevated text-fg focus:ring-ring h-9 w-20 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-offset-1"
            />
            <span className="text-fg-muted text-sm">variations</span>
          </div>
        </div>
        {/* Polish-20.0.1: length picker removed. Duration flows from
            client-side detection → worker's Polish-19.3.1 fallback
            chain. Users who need explicit control go to /advanced. */}
        <div>
          <p className="text-fg block text-sm font-medium">Length</p>
          {detectedSourceSeconds != null ? (
            <p className="text-fg-muted mt-1 text-sm">
              Auto-detected: <span className="text-fg font-mono">{detectedSourceSeconds}s</span>{' '}
              <span className="text-fg-subtle text-xs">from source video</span>
            </p>
          ) : (
            <p className="text-fg-subtle mt-1 text-xs">Auto-detected from source video.</p>
          )}
          <p className="text-fg-subtle mt-1 text-xs">
            Need an override? Use the{' '}
            <Link
              href={`/concepts/${conceptId}/generate/advanced`}
              className="hover:text-fg underline underline-offset-4"
            >
              advanced form
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Cost estimate */}
      <div
        className={cn(
          'border-border bg-bg-surface rounded-md border px-4 py-3 text-sm',
          overCap && 'border-[color:var(--accent-negative)]/60',
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-fg-muted">Estimated cost (your keys)</span>
          <span className="text-fg font-mono text-base">
            {estimate ? `$${estimate.estimateUsd.toFixed(2)}` : '—'}
          </span>
        </div>
        {estimate != null && detectionPending && (
          <p className="text-fg-subtle mt-1 text-xs">
            Cost calculated after source analysis — showing preview at{' '}
            {SIMPLIFIED_DEFAULT_DURATION_SECONDS}s default.
          </p>
        )}
        {estimate != null && !detectionPending && (
          <p className="text-fg-subtle mt-1 text-xs">
            {variantCount} variation{variantCount === 1 ? '' : 's'} × {previewSeconds}s each
          </p>
        )}
        {overCap && (
          <p className="mt-1 text-xs text-[color:var(--accent-negative)]">
            Over your remaining daily cap (${remaining.toFixed(2)} left). Raise the cap on Settings,
            reduce variants, or pick a cheaper model.
          </p>
        )}
        {!hasKieKey && modelId != null && (
          <p className="mt-1 text-xs text-[color:var(--accent-negative)]">
            Connect your kie.ai key on{' '}
            <Link href="/connections/tools" className="hover:text-fg underline underline-offset-4">
              /connections/tools
            </Link>{' '}
            to generate.
          </p>
        )}
      </div>

      {error && (
        <div className="border-[color:var(--accent-negative)]/40 bg-[color:var(--accent-negative)]/10 text-fg rounded-md border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-fg-subtle text-xs">
          Spent today: ${spentTodayUsd.toFixed(2)} / ${capUsd.toFixed(2)}
        </p>
        <Button
          type="submit"
          disabled={isPending || overCap || !canSubmit || !hasKieKey}
          title={
            !canSubmit
              ? 'Pick a model to generate variations.'
              : !hasKieKey
                ? 'Connect a kie.ai key to generate.'
                : undefined
          }
        >
          {isPending ? 'Generating…' : 'Generate variations'}
        </Button>
      </div>

      {/* First-time live-spend acknowledgment */}
      <Dialog open={showLiveDialog} onOpenChange={setShowLiveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm live generation</DialogTitle>
            <DialogDescription>
              This will spend real money on your connected provider keys. Estimated cost:{' '}
              {estimate ? `$${estimate.estimateUsd.toFixed(2)}` : '—'}. You only see this dialog
              once.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={confirmLiveDialog} disabled={isPending}>
              I understand, generate
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}

interface ModelCardProps {
  model: VideoModel;
  picked: boolean;
  disabled: boolean;
  targetSeconds: number;
  onPick: () => void;
}

function ModelCard({ model, picked, disabled, targetSeconds, onPick }: ModelCardProps) {
  const recommended = isRecommendedTier(model.id);
  // Card shows the per-variant cost hint at the CURRENT preset so
  // switching between 8s/15s/30s/60s live-updates every card.
  const defaultProviderId = getDefaultProviderForModel(model.id)?.id;
  const costHint = defaultProviderId
    ? formatModelCostHintPerVariant(model.id, defaultProviderId, targetSeconds)
    : '';
  const tierLabel =
    model.qualityTier === 'budget'
      ? 'Budget'
      : model.qualityTier === 'recommended'
        ? 'Recommended'
        : 'Premium';

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={picked}
      className={cn(
        'group relative flex flex-col items-start gap-2 rounded-md border p-4 text-left transition-colors',
        picked
          ? 'border-fg bg-fg/5'
          : recommended
            ? 'border-[color:var(--accent-positive)]/50 bg-bg-surface hover:border-fg/50'
            : 'border-border bg-bg-surface hover:border-fg/50',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      {recommended && !picked && (
        <span className="bg-[color:var(--accent-positive)]/15 absolute right-3 top-3 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--accent-positive)]">
          Recommended
        </span>
      )}
      {picked && (
        <CheckCircle2 className="text-fg absolute right-3 top-3 h-4 w-4" aria-hidden="true" />
      )}
      <div className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">
        {tierLabel}
      </div>
      <div className="text-fg text-sm font-semibold">{model.displayName}</div>
      <div className="text-fg-muted text-xs leading-relaxed">{model.description}</div>
      <div className="text-fg-subtle mt-auto pt-2 font-mono text-xs">{costHint}</div>
    </button>
  );
}
