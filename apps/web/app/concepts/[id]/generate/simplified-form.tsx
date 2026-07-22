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
  LAUNCHER_VISIBLE_MODELS,
  POLISH23_DESCRIPTION,
  POLISH23_DISPLAY_NAME,
  POLISH25_DESCRIPTION,
  POLISH25_DISPLAY_NAME,
  SIMPLIFIED_DEFAULT_DURATION_SECONDS,
  SIMPLIFIED_DEFAULT_VARIANTS,
  SIMPLIFIED_MAX_VARIANTS,
  SIMPLIFIED_MIN_VARIANTS,
  buildSubmissionFormData,
  canSubmitState,
  clampVariantCount,
  estimatePolish23CostPerVariantUsd,
  estimatePolish25CostPerVariantUsd,
  formatModelCostHintPerVariant,
  getDefaultProviderForModel,
  getSoleLauncherModel,
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
 * Polish-20 → Polish-21: simplified generation form.
 *
 * Polish-21: with a single launcher-visible model (Hedra Character 3)
 * the 3-card model picker is hidden and the sole model auto-selects
 * on mount. When a second visible model lands (Polish-22 HeyGen
 * candidate) getSoleLauncherModel returns null and the picker
 * automatically reappears.
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

  // Polish-21: when there's exactly one launcher-visible model
  // (Hedra Character 3), auto-select it and hide the picker. Multi-
  // model state (Polish-22+) falls back to "user must pick".
  //
  // Polish-25.1 Commit 10b: Polish-25 (MakeUGC) is now the DEFAULT
  // selection on mount — the recommended primary pipeline shouldn't
  // require an extra click. If the user has the Polish-25 keys
  // connected, we start with polish25Selected=true and everything
  // else cleared. If they don't, we fall back to soleModel so the
  // form still has a picked state to submit against.
  const soleModel = getSoleLauncherModel();
  const canDefaultPolish25 =
    connectedProviders.claude.connected &&
    connectedProviders.gemini.connected &&
    connectedProviders.makeugc.connected;
  const [modelId, setModelId] = React.useState<VideoModelId | null>(
    canDefaultPolish25 ? null : soleModel ? soleModel.id : null,
  );
  // Polish-23 Commit 3.5: alternative "picked" state that bypasses
  // the VideoModel descriptor system. Picking Polish-23 clears
  // modelId; picking any classic model clears polish23Selected.
  const [polish23Selected, setPolish23Selected] = React.useState(false);
  // Polish-25 Commit 2: MakeUGC pre-cast avatar picker. Mutually
  // exclusive with polish23Selected + modelId. Polish-25.1 Commit 10b:
  // defaults to picked when the Polish-25 keys are all connected.
  const [polish25Selected, setPolish25Selected] = React.useState(canDefaultPolish25);
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
    polish23Selected,
    polish25Selected,
  };
  const canSubmit = canSubmitState(state);

  // Polish-20.0.1: cost preview uses the client-detected source
  // duration when available; falls back to the shared default (30s)
  // when detection is still pending. The worker's Polish-19.3.1
  // fallback chain resolves the final target server-side, so this
  // number is a preview only.
  const previewSeconds = detectedSourceSeconds ?? SIMPLIFIED_DEFAULT_DURATION_SECONDS;
  const detectionPending = detectedSourceSeconds == null;
  // Polish-23 Commit 3.5: polish23 cost preview is a per-variant
  // constant (Commit 3 pipeline runs a fixed 8-clip Veo Lite chain).
  // Duration doesn't scale it; the multiplier is variantCount only.
  const polish23Estimate = polish23Selected
    ? {
        estimateUsd: variantCount * estimatePolish23CostPerVariantUsd(detectedSourceSeconds).usd,
      }
    : null;
  // Polish-25 Commit 2: fixed per-variant cost, duration doesn't scale.
  const polish25Estimate = polish25Selected
    ? { estimateUsd: variantCount * estimatePolish25CostPerVariantUsd().usd }
    : null;
  const estimate = polish25Estimate
    ? polish25Estimate
    : polish23Estimate
      ? polish23Estimate
      : modelId
        ? estimateGenerationCost({
            conceptType: 'ugc',
            variantCount,
            videoModelId: modelId,
            sourceDurationSeconds: previewSeconds,
          })
        : null;

  const remaining = Math.max(0, capUsd - spentTodayUsd);
  const overCap = estimate != null && estimate.estimateUsd > remaining;

  // Polish-21: Hedra Character 3 requires a Hedra API key. Replaces
  // the Polish-20 kie.ai gate — the form still renders even when
  // disconnected so operators can see the cost preview, but Generate
  // stays disabled with a "connect Hedra" nudge.
  // Polish-21.0.4 hotfix: worker needs BOTH keys (Hedra for video
  // generation + ElevenLabs for TTS audio uploaded as a Hedra
  // audio asset). Generate stays disabled until both are connected.
  const hasHedraKey = connectedProviders.hedra.connected;
  const hasElevenLabsKey = connectedProviders.elevenlabs.connected;
  // Polish-23 Commit 3.5: polish23 has a different key gate. Needs
  // Claude (Anthropic ad-spec) + WaveSpeedAI (Higgsfield Soul) +
  // kie.ai (Veo Lite) + Replicate (ffmpeg-concat). Any missing key
  // surfaces its label in the disabled-Generate tooltip.
  const polish23MissingKeys: string[] = [];
  if (!connectedProviders.claude.connected) polish23MissingKeys.push('Claude');
  if (!connectedProviders.wavespeed_ai.connected) polish23MissingKeys.push('WaveSpeedAI');
  if (!connectedProviders.kie_ai.connected) polish23MissingKeys.push('kie.ai');
  if (!connectedProviders.replicate.connected) polish23MissingKeys.push('Replicate');
  const hasPolish23Keys = polish23MissingKeys.length === 0;

  // Polish-25 Commit 2: MakeUGC gate. Needs Claude (script condenser)
  // + Gemini (concept vision analysis via analyze-concept) + MakeUGC.
  const polish25MissingKeys: string[] = [];
  if (!connectedProviders.claude.connected) polish25MissingKeys.push('Claude');
  if (!connectedProviders.gemini.connected) polish25MissingKeys.push('Gemini');
  if (!connectedProviders.makeugc.connected) polish25MissingKeys.push('MakeUGC');
  const hasPolish25Keys = polish25MissingKeys.length === 0;

  const legacyMissingKeys: string[] = [];
  if (!hasHedraKey) legacyMissingKeys.push('Hedra');
  if (!hasElevenLabsKey) legacyMissingKeys.push('ElevenLabs');
  const hasLegacyKeys = hasHedraKey && hasElevenLabsKey;

  const hasProviderKey = polish25Selected
    ? hasPolish25Keys
    : polish23Selected
      ? hasPolish23Keys
      : hasLegacyKeys;
  const missingKeys = polish25Selected
    ? polish25MissingKeys
    : polish23Selected
      ? polish23MissingKeys
      : legacyMissingKeys;

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

      {/* Polish-25 Commit 2: MakeUGC pre-cast avatar card — primary
          recommended pipeline going forward. Positioned FIRST.
          Character consistency guaranteed at platform level, ~$0.05
          per 60s ad (20-50x cheaper than Polish-23). Picking clears
          Polish-23 + modelId. */}
      <Polish25PickerCard
        picked={polish25Selected}
        disabled={isPending}
        variantCount={variantCount}
        onPick={() => {
          setPolish25Selected(true);
          setPolish23Selected(false);
          setModelId(null);
        }}
      />

      {/* Polish-25.1 Commit 10b: Polish-23 picker + classic model
          picker + advanced-form link collapsed into a "Change model"
          <details> block. Polish-25 is the default; users who need
          an alternate pipeline (Higgsfield Soul / Hedra / OpenAI
          Sora / Nano Banana) expand this section deliberately. The
          collapse defaults to OPEN when Polish-25 is not the picked
          state so users who arrive on the form without Polish-25
          keys still see the fallback picker without clicking. */}
      <details className="border-border-subtle group rounded-md border" open={!polish25Selected}>
        <summary className="text-fg-muted hover:text-fg cursor-pointer list-none px-4 py-3 text-xs font-medium uppercase tracking-wider transition-colors">
          Change model
          <span className="ml-2 text-[10px] normal-case tracking-normal">
            (Polish-23 Higgsfield · Hedra · Sora · Nano Banana)
          </span>
        </summary>
        <div className="border-border-subtle space-y-4 border-t p-4">
          <Polish23PickerCard
            picked={polish23Selected}
            disabled={isPending}
            variantCount={variantCount}
            onPick={() => {
              setPolish23Selected(true);
              setPolish25Selected(false);
              setModelId(null);
            }}
          />

          {soleModel ? (
            <section aria-labelledby="model-picker-heading" className="space-y-2">
              <h2 id="model-picker-heading" className="text-fg text-sm font-medium">
                Legacy model
              </h2>
              <div className="border-border bg-bg-surface rounded-md border px-4 py-3 text-sm">
                <span className="text-fg font-semibold">{soleModel.displayName}</span>{' '}
                <span className="text-fg-subtle text-xs">— {soleModel.description}</span>
              </div>
            </section>
          ) : (
            <section aria-labelledby="model-picker-heading" className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 id="model-picker-heading" className="text-fg text-sm font-medium">
                  Legacy models
                </h2>
                <span className="text-fg-subtle text-xs">
                  Kept for compatibility with pre-Polish-25 flows
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {LAUNCHER_VISIBLE_MODELS.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    picked={modelId === model.id}
                    disabled={isPending}
                    targetSeconds={previewSeconds}
                    onPick={() => {
                      setModelId(model.id);
                      setPolish23Selected(false);
                      setPolish25Selected(false);
                    }}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </details>

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
        {!hasProviderKey && (modelId != null || polish23Selected || polish25Selected) && (
          <p className="mt-1 text-xs text-[color:var(--accent-negative)]">
            Connect your {missingKeys.join(' + ')} key{missingKeys.length > 1 ? 's' : ''} on{' '}
            <Link
              href="/settings/connections"
              className="hover:text-fg underline underline-offset-4"
            >
              Settings → Connections
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
          disabled={isPending || overCap || !canSubmit || !hasProviderKey}
          title={
            !canSubmit
              ? 'Pick a model to generate variations.'
              : !hasProviderKey
                ? `Connect ${missingKeys.join(' + ')} key${missingKeys.length > 1 ? 's' : ''} to generate.`
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

interface Polish23PickerCardProps {
  picked: boolean;
  disabled: boolean;
  variantCount: number;
  onPick: () => void;
}

/**
 * Polish-25 Commit 2: MakeUGC pre-cast avatar picker card. Same
 * visual language as Polish23PickerCard but positioned FIRST in the
 * form (primary recommended pipeline). Character consistency
 * guaranteed at platform level (pre-cast avatar library) at
 * ~$0.05 per 60s ad — 20-50x cheaper than Polish-23.
 */
function Polish25PickerCard({ picked, disabled, variantCount, onPick }: Polish23PickerCardProps) {
  const perVariantUsd = estimatePolish25CostPerVariantUsd().usd;
  const totalUsd = perVariantUsd * variantCount;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={picked}
      className={cn(
        'group relative flex w-full flex-col gap-2 rounded-md border p-4 text-left transition-colors',
        picked
          ? 'border-fg bg-fg/5'
          : 'border-[color:var(--accent-positive)]/50 bg-bg-surface hover:border-fg/50',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'absolute right-3 top-3 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
          'bg-[color:var(--accent-positive)]/15 text-[color:var(--accent-positive)]',
        )}
      >
        Primary — Recommended
      </span>
      {picked && (
        <CheckCircle2 className="text-fg absolute right-24 top-3 h-4 w-4" aria-hidden="true" />
      )}
      <div className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">
        Polish-25 pipeline
      </div>
      <div className="text-fg text-sm font-semibold">{POLISH25_DISPLAY_NAME}</div>
      <div className="text-fg-muted text-xs leading-relaxed">{POLISH25_DESCRIPTION}</div>
      <div className="text-fg-subtle mt-1 font-mono text-xs">
        ~${perVariantUsd.toFixed(4)}/variant × {variantCount} = ${totalUsd.toFixed(4)}
      </div>
    </button>
  );
}

function Polish23PickerCard({ picked, disabled, variantCount, onPick }: Polish23PickerCardProps) {
  const perVariantUsd = estimatePolish23CostPerVariantUsd(null).usd;
  const totalUsd = perVariantUsd * variantCount;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={picked}
      className={cn(
        'group relative flex w-full flex-col gap-2 rounded-md border p-4 text-left transition-colors',
        picked
          ? 'border-fg bg-fg/5'
          : 'border-[color:var(--accent-positive)]/50 bg-bg-surface hover:border-fg/50',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'absolute right-3 top-3 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
          'bg-[color:var(--accent-positive)]/15 text-[color:var(--accent-positive)]',
        )}
      >
        New — Recommended
      </span>
      {picked && (
        <CheckCircle2 className="text-fg absolute right-24 top-3 h-4 w-4" aria-hidden="true" />
      )}
      <div className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">
        Polish-23 pipeline
      </div>
      <div className="text-fg text-sm font-semibold">{POLISH23_DISPLAY_NAME}</div>
      <div className="text-fg-muted text-xs leading-relaxed">{POLISH23_DESCRIPTION}</div>
      <div className="text-fg-subtle mt-1 font-mono text-xs">
        ~${perVariantUsd.toFixed(2)}/variant × {variantCount} = ${totalUsd.toFixed(2)}
      </div>
    </button>
  );
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
