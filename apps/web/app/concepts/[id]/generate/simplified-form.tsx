'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  defaultPipeline,
  describePipeline,
  estimateGenerationCost,
  type PipelineType,
} from '@mbb/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { VoicePicker } from '@/components/forms/voice-picker';
import { cn } from '@/lib/utils';
import { acknowledgeLiveGenerationAction } from './ack-action';
import { createGenerationJobAction, type ConnectedProviders } from './actions';
import {
  SIMPLIFIED_DEFAULT_LENGTH_SECONDS,
  SIMPLIFIED_DEFAULT_VARIANTS,
  SIMPLIFIED_MAX_LENGTH_SECONDS,
  SIMPLIFIED_MAX_VARIANTS,
  SIMPLIFIED_MIN_LENGTH_SECONDS,
  SIMPLIFIED_MIN_VARIANTS,
  buildSubmissionFormData,
  clampLengthSeconds,
  clampVariantCount,
} from './simplified-form-helpers';

interface Props {
  conceptId: string;
  /** Optional preview URL — signed Supabase URL for UGC sources, fileUrl for static. */
  sourcePreviewUrl: string | null;
  /** Detected source duration (seconds), if known. Seeds the Length picker. */
  detectedSourceSeconds: number | null;
  /** Pipelines the user has the keys for. Drives the Pipeline picker options. */
  connectedProviders: ConnectedProviders;
  /** Daily-cap state for the upfront over-cap warning. */
  spentTodayUsd: number;
  capUsd: number;
  /** Has the user already acknowledged the first-time live-spend dialog? */
  liveAcknowledged: boolean;
}

/**
 * Polish-19 Commit 3: simplified generation form.
 *
 * Three visible controls: variant count, length, submit. Pipeline +
 * voice live in the Advanced disclosure (collapsed by default). The
 * full original form lives at /concepts/[id]/generate/advanced for
 * power users — link surfaced inside the disclosure.
 *
 * Submission shape matches the existing createGenerationJobAction
 * FormData contract (see actions.ts). `intensity` is hardcoded to
 * 'medium' since the simplified form doesn't expose the picker.
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

  const [pipeline, setPipeline] = React.useState<PipelineType>(defaultPipeline());
  const [voiceId, setVoiceId] = React.useState<string>(DEFAULT_ELEVENLABS_VOICE_ID);
  const [variantCount, setVariantCount] = React.useState<number>(SIMPLIFIED_DEFAULT_VARIANTS);
  const [lengthSeconds, setLengthSeconds] = React.useState<number>(
    detectedSourceSeconds ?? SIMPLIFIED_DEFAULT_LENGTH_SECONDS,
  );
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  const [error, setError] = React.useState<string | null>(null);
  const [liveAck, setLiveAck] = React.useState(initialLiveAck);
  const [showLiveDialog, setShowLiveDialog] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  // Polish-19: estimator runs on every state change so the displayed
  // cost is what we submit.
  // Polish-19.3.1: for Veo the form no longer surfaces a length
  // picker — the worker auto-resolves duration from the analyze
  // step + 30s default fallback. The cost preview uses
  // detectedSourceSeconds when known (page passes it in once
  // analyze-concept completes), otherwise the same 30s default the
  // worker would land on. For non-Veo pipelines the length picker
  // stays visible and feeds the preview.
  const isVeoPipeline = pipeline === 'veo_3_1_fast_native_audio';
  const previewDurationSeconds = isVeoPipeline ? (detectedSourceSeconds ?? 30) : lengthSeconds;
  const estimate = estimateGenerationCost({
    conceptType: 'ugc',
    variantCount,
    pipeline,
    sourceDurationSeconds: previewDurationSeconds,
  });

  const remaining = Math.max(0, capUsd - spentTodayUsd);
  const overCap = estimate.estimateUsd > remaining;

  // Polish-19: surface only pipelines the user has keys for so they
  // can't pick something that'll instantly MissingProviderKeyError.
  const availablePipelines: PipelineType[] = React.useMemo(() => {
    const all: PipelineType[] = [
      // Polish-19.2: Veo 3.1 Fast is the new default. Kling Avatar
      // v2 stays available for users who want the image+lipsync
      // chain. Omni Flash + HeyGen remain advanced options.
      'veo_3_1_fast_native_audio',
      'kie_kling_avatar_v2_standard',
      'kie_omni_flash_native',
      'heygen_avatar_talking_head',
    ];
    return all.filter((p) => {
      const d = describePipeline(p);
      return d.requiredProviders.every((req) => {
        if (req === 'claude') return connectedProviders.claude.connected;
        if (req === 'gemini') return connectedProviders.gemini.connected;
        if (req === 'kie_ai') return connectedProviders.kie_ai.connected;
        if (req === 'kling') return connectedProviders.kling.connected;
        if (req === 'elevenlabs') return connectedProviders.elevenlabs.connected;
        if (req === 'heygen') return connectedProviders.heygen.connected;
        if (req === 'openai') return connectedProviders.openai.connected;
        return false;
      });
    });
  }, [connectedProviders]);

  // Polish-19: if the canonical default isn't available (user hasn't
  // connected its providers yet), drop to the first pipeline they CAN
  // run rather than letting them stare at a non-functional dropdown.
  React.useEffect(() => {
    if (!availablePipelines.includes(pipeline) && availablePipelines.length > 0) {
      setPipeline(availablePipelines[0]!);
    }
  }, [availablePipelines, pipeline]);

  // Polish-19.3.1: Veo no longer surfaces a length picker so the
  // snap-on-pipeline-switch from 19.3 Commit 1 isn't needed anymore.
  // For non-Veo pipelines the length picker stays free-form and the
  // user's existing value is honored on switch.

  function performSubmit() {
    if (overCap) return;
    const formData = buildSubmissionFormData({
      conceptId,
      state: { pipeline, voiceId, variantCount, lengthSeconds },
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

      {/* Primary controls */}
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

        {/* Polish-19.3.1: Veo no longer shows a Length picker — the
            worker auto-resolves output duration from the source
            video's analyze-concept output (with a 30s default). For
            other pipelines (Kling, Omni Flash, HeyGen) the free-form
            length input stays. */}
        {!isVeoPipeline && (
          <div>
            <label htmlFor="length-seconds" className="text-fg block text-sm font-medium">
              Length
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="length-seconds"
                type="number"
                min={SIMPLIFIED_MIN_LENGTH_SECONDS}
                max={SIMPLIFIED_MAX_LENGTH_SECONDS}
                step={1}
                value={lengthSeconds}
                onChange={(e) => setLengthSeconds(clampLengthSeconds(Number(e.target.value)))}
                disabled={isPending}
                className="border-input bg-bg-elevated text-fg focus:ring-ring h-9 w-24 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-offset-1"
              />
              <span className="text-fg-muted text-sm">seconds each</span>
            </div>
          </div>
        )}
        {isVeoPipeline && (
          <div>
            <p className="text-fg block text-sm font-medium">Length</p>
            <p className="text-fg-muted mt-1 text-xs">
              Auto-set from source video
              {detectedSourceSeconds != null
                ? ` (${detectedSourceSeconds}s detected)`
                : ' (30s default until analyzed)'}
              . Override in the Advanced form below.
            </p>
          </div>
        )}
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
          <span className="text-fg font-mono text-base">${estimate.estimateUsd.toFixed(2)}</span>
        </div>
        {overCap && (
          <p className="mt-1 text-xs text-[color:var(--accent-negative)]">
            Over your remaining daily cap (${remaining.toFixed(2)} left). Raise the cap on Settings
            or reduce variants / length.
          </p>
        )}
      </div>

      {/* Advanced disclosure */}
      <details
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
        className="border-border bg-bg-surface rounded-md border"
      >
        <summary className="text-fg hover:text-fg flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')}
          />
          Advanced
        </summary>
        <div className="border-border-subtle space-y-4 border-t px-4 py-4">
          <div>
            <label htmlFor="pipeline" className="text-fg text-xs font-medium">
              Pipeline
            </label>
            <select
              id="pipeline"
              aria-label="Pipeline"
              value={pipeline}
              onChange={(e) => setPipeline(e.target.value as PipelineType)}
              disabled={isPending || availablePipelines.length === 0}
              className="border-input bg-bg-elevated text-fg focus:ring-ring mt-1 h-9 w-full rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {availablePipelines.length === 0 ? (
                <option value="">No pipelines available — connect a provider</option>
              ) : (
                availablePipelines.map((p) => (
                  <option key={p} value={p}>
                    {describePipeline(p).label}
                  </option>
                ))
              )}
            </select>
            <p className="text-fg-muted mt-1 text-xs">
              {describePipeline(pipeline).label === describePipeline(defaultPipeline()).label
                ? 'Default — recommended for most ads.'
                : 'Non-default pipeline selected.'}
            </p>
          </div>

          <VoicePicker value={voiceId} onChange={setVoiceId} disabled={isPending} />

          <div className="border-border-subtle border-t pt-3 text-xs">
            <Link
              href={`/concepts/${conceptId}/generate/advanced`}
              className="text-fg-muted hover:text-fg underline-offset-4 transition-colors hover:underline"
            >
              Want more control? Switch to advanced form →
            </Link>
          </div>
        </div>
      </details>

      {error && (
        <div className="border-[color:var(--accent-negative)]/40 bg-[color:var(--accent-negative)]/10 text-fg rounded-md border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-fg-subtle text-xs">
          Spent today: ${spentTodayUsd.toFixed(2)} / ${capUsd.toFixed(2)}
        </p>
        <Button type="submit" disabled={isPending || overCap || availablePipelines.length === 0}>
          {isPending ? 'Generating…' : 'Generate variations'}
        </Button>
      </div>

      {/* First-time live-spend acknowledgment */}
      <Dialog open={showLiveDialog} onOpenChange={setShowLiveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm live generation</DialogTitle>
            <DialogDescription>
              This will spend real money on your connected provider keys. Estimated cost: $
              {estimate.estimateUsd.toFixed(2)}. You only see this dialog once.
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
