'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ALL_PIPELINES,
  MAX_VARIANTS_PER_JOB,
  describePipeline,
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
  createReferenceUploadUrl,
  detectAndRouteFromStoragePath,
} from './actions';

// Polish-9: client-side cap matches the bucket file_size_limit set in
// migration 0028. Reject larger files BEFORE we hit Supabase Storage.
const MAX_REFERENCE_BYTES = 100 * 1024 * 1024;

interface Props {
  conceptId: string;
  conceptType: ConceptType;
  spentTodayUsd: number;
  capUsd: number;
  liveAcknowledged: boolean;
  /** Polish-4: drives the provider + format pickers. */
  connectedProviders: ConnectedProviders;
  /**
   * Polish-14.1: signed URL of the uploaded UGC source. Null for image
   * concepts or when signing failed. When present, the form mounts a
   * hidden <video> element and reads duration on metadata load so the
   * upfront cost preview matches what the worker will actually generate.
   */
  sourceVideoUrl?: string | null;
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
  sourceVideoUrl,
}: Props) {
  const router = useRouter();
  const [intensity, setIntensity] = React.useState<'small' | 'medium' | 'big'>('medium');
  const [variantCount, setVariantCount] = React.useState<number>(10);
  const [liveAck, setLiveAck] = React.useState(initialLiveAck);
  const [showLiveDialog, setShowLiveDialog] = React.useState(false);
  const [showOverrideDialog, setShowOverrideDialog] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Polish-6 + Polish-9.2: auto-detect creative format + pipeline.
  // overridePipeline (when set) takes precedence over the detection.
  // effectivePipeline is what actually drives submission + cost estimate.
  const [detection, setDetection] = React.useState<DetectAndRouteResult | null>(null);
  const [detecting, setDetecting] = React.useState(false);
  const [overridePipeline, setOverridePipeline] = React.useState<PipelineType | null>(null);
  // Polish-10.3: default to whatever the detector returns. The Polish-10
  // silent upgrade to kling_3_omni_multi_segment is reverted — the
  // legacy multi-clip pipeline produces better output today and is the
  // default again. Omni stays available via the Override Dialog for
  // users who want to experiment.
  const detectedPipeline = (detection?.pipeline as PipelineType | undefined) ?? null;
  const effectivePipeline: PipelineType | null = overridePipeline ?? detectedPipeline;

  const heygenReady = connectedProviders.heygen.connected;
  // Pipeline is the source of truth — format derives from it.
  const effectiveDescriptor = effectivePipeline ? describePipeline(effectivePipeline) : null;
  const effectiveFormat = (effectiveDescriptor?.format ?? 'avatar_talking_head') as CreativeFormat;

  // Polish-14.1: source duration is detected client-side from a hidden
  // <video> element once the signed URL loads. Until it resolves the
  // estimate falls back to the 30s default in the shared estimator.
  const [sourceDurationSeconds, setSourceDurationSeconds] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!sourceVideoUrl) return;
    let cancelled = false;
    void import('./detect-video-duration').then(({ detectVideoDurationFromUrl }) =>
      detectVideoDurationFromUrl(sourceVideoUrl).then((d) => {
        if (!cancelled && typeof d === 'number') {
          setSourceDurationSeconds(d);
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [sourceVideoUrl]);

  const estimate = React.useMemo(
    () =>
      estimateGenerationCost({
        conceptType,
        variantCount: Math.max(1, Math.min(MAX_VARIANTS_PER_JOB, variantCount || 1)),
        provider: conceptType === 'ugc' ? 'heygen' : undefined,
        format: conceptType === 'ugc' ? effectiveFormat : undefined,
        pipeline: effectivePipeline ?? undefined,
        sourceDurationSeconds: sourceDurationSeconds ?? undefined,
      }),
    [conceptType, variantCount, effectiveFormat, effectivePipeline, sourceDurationSeconds],
  );

  const [referenceStoragePath, setReferenceStoragePath] = React.useState<string | null>(null);

  async function handleReferenceUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Polish-9: validate before anything else.
    if (file.size > MAX_REFERENCE_BYTES) {
      setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 100 MB.`);
      return;
    }

    setDetecting(true);
    setDetection(null);
    setError(null);
    setReferenceStoragePath(null);

    try {
      // 1. Get a signed upload URL (server action; tiny payload, no 4.5 MB risk).
      const signed = await createReferenceUploadUrl(file.name, file.type);
      if (!signed || !signed.ok || !signed.uploadUrl || !signed.storagePath) {
        setError(signed?.errorMessage ?? 'Could not create upload URL.');
        return;
      }

      // 2. PUT the file directly to Supabase Storage. Bypasses Vercel's
      //    4.5 MB request limit entirely.
      let uploadResponse: Response | undefined;
      try {
        uploadResponse = await fetch(signed.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
      } catch (netErr) {
        setError(
          `Upload network error: ${netErr instanceof Error ? netErr.message : String(netErr)}`,
        );
        return;
      }
      if (!uploadResponse || !uploadResponse.ok) {
        const status = uploadResponse?.status;
        if (status === 413) {
          setError('File too large (max 100 MB).');
        } else {
          setError(`Upload failed${status ? ` (HTTP ${status})` : ''}.`);
        }
        return;
      }

      setReferenceStoragePath(signed.storagePath);

      // 3. Run vision detection server-side on the uploaded file.
      const result = await detectAndRouteFromStoragePath(signed.storagePath, file.type);
      if (!result) {
        setError('Detection returned no result.');
        return;
      }
      setDetection(result);
      if (!result.ok && result.errorMessage) setError(result.errorMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
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
    // Polish-9.2: pipeline is the canonical routing input. format +
    // providerChoice derive from the descriptor on the server. We send
    // the effective pipeline (override OR detected); when neither is set
    // the server falls back to heygen_avatar_talking_head for legacy
    // concepts without a reference upload.
    if (effectivePipeline) formData.set('pipeline', effectivePipeline);
    // Polish-9: pass the uploaded reference's storage path so the job
    // row can re-load it later for re-detection or downstream pipelines.
    if (referenceStoragePath) formData.set('referenceStoragePath', referenceStoragePath);
    // Polish-14.1: the worker's target_duration_seconds. The estimate
    // already used this value above so the displayed cost matches the
    // job we're actually submitting.
    if (sourceDurationSeconds && sourceDurationSeconds > 0) {
      formData.set('sourceDurationSeconds', String(sourceDurationSeconds));
    }

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
          {(detection?.ok && detection.detection) || effectivePipeline ? (
            <div className="bg-bg-elevated space-y-1.5 rounded-md border p-3 text-sm">
              {detection?.ok && detection.detection && (
                <p>
                  <span className="text-fg-muted">Detected: </span>
                  <span className="text-fg font-mono font-medium">
                    {detection.detection.format.replace(/_/g, ' ')}
                  </span>
                </p>
              )}
              {effectiveDescriptor && (
                <p>
                  <span className="text-fg-muted">Pipeline: </span>
                  <span className="text-fg font-mono font-medium">
                    {effectiveDescriptor.label}
                  </span>{' '}
                  {overridePipeline ? (
                    <span className="text-fg-muted text-xs">
                      (manual override —{' '}
                      <button
                        type="button"
                        className="hover:text-fg underline"
                        onClick={() => setOverridePipeline(null)}
                      >
                        reset to auto
                      </button>
                      )
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="text-fg-muted hover:text-fg ml-1 text-xs underline"
                      onClick={() => setShowOverrideDialog(true)}
                    >
                      Override
                    </button>
                  )}
                </p>
              )}
              {detection?.detection?.demographics?.gender && (
                <p className="text-fg-muted text-xs">
                  {detection.detection.demographics.gender}
                  {detection.detection.demographics.ageRange
                    ? `, ${detection.detection.demographics.ageRange}`
                    : ''}
                </p>
              )}
              {detection?.errorMessage && !detection.pipeline && !overridePipeline && (
                <p className="text-xs text-[color:var(--destructive-color)]">
                  {detection.errorMessage}
                </p>
              )}
            </div>
          ) : null}
          {!detection && !detecting && !overridePipeline && (
            <div className="space-y-1">
              <p className="text-fg-muted text-xs">
                No reference? Default: {heygenReady ? 'HeyGen Avatar Mode' : 'pick one manually'}.
              </p>
              <button
                type="button"
                className="text-fg-muted hover:text-fg text-xs underline"
                onClick={() => setShowOverrideDialog(true)}
              >
                Pick a pipeline manually
              </button>
            </div>
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

      {/* Polish-9.2: pipeline override picker. */}
      <Dialog open={showOverrideDialog} onOpenChange={setShowOverrideDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick a generation pipeline</DialogTitle>
            <DialogDescription>
              Override what the bot auto-detected. Greyed-out options need a provider you
              haven&rsquo;t connected yet.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-2">
            {ALL_PIPELINES.map((p) => {
              const desc = describePipeline(p);
              const ready = providerReadyForPipeline(p, connectedProviders);
              const selected = (overridePipeline ?? detectedPipeline) === p;
              return (
                <label
                  key={p}
                  className={
                    'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ' +
                    (!ready
                      ? 'bg-bg-elevated cursor-not-allowed opacity-50'
                      : selected
                        ? 'border-fg-muted bg-bg-hover'
                        : 'bg-bg-elevated hover:bg-bg-hover')
                  }
                >
                  <input
                    type="radio"
                    name="overridePipeline"
                    value={p}
                    checked={selected}
                    disabled={!ready}
                    onChange={() => setOverridePipeline(p)}
                    className="mt-1 h-4 w-4"
                  />
                  <span className="flex-1">
                    <span className="text-fg block text-sm font-medium">{desc.label}</span>
                    {!ready && (
                      <span className="text-fg-muted block text-xs">
                        Connect {desc.requiredProviders.join(' + ')} on /connections to enable.
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => setShowOverrideDialog(false)}
              disabled={!overridePipeline && !detectedPipeline}
            >
              Use this pipeline
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}

function providerReadyForPipeline(pipeline: PipelineType, conns: ConnectedProviders): boolean {
  const required = describePipeline(pipeline).requiredProviders;
  for (const r of required) {
    if (r === 'heygen' && !conns.heygen.connected) return false;
    if (r === 'kling' && !conns.kling.connected) return false;
    if (r === 'openai' && !conns.openai.connected) return false;
    if (r === 'gemini' && !conns.gemini.connected) return false;
    if (r === 'elevenlabs' && !conns.elevenlabs.connected) return false;
    // Polish-12: kie.ai + Claude land here. Both live in
    // tool_connections (paste API key at /connections/tools).
    if (r === 'claude' && !conns.claude.connected) return false;
    if (r === 'kie_ai' && !conns.kie_ai.connected) return false;
  }
  return true;
}
