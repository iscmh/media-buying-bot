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
  // Polish-28.0.0 Commit 64: cloned-UGC card constants.
  POLISH28_DESCRIPTION,
  POLISH28_DISPLAY_NAME,
  POLISH28_VARIATIONS_DESCRIPTION,
  POLISH28_VARIATIONS_DISPLAY_NAME,
  estimatePolish28CostPerVariantUsd,
  estimatePolish28VariationsCostPerVariantUsd,
  SIMPLIFIED_DEFAULT_DURATION_SECONDS,
  SIMPLIFIED_DEFAULT_VARIANTS,
  SIMPLIFIED_MAX_VARIANTS,
  SIMPLIFIED_MIN_VARIANTS,
  STATIC_OPENAI_DEFAULT_QUALITY,
  STATIC_OPENAI_DESCRIPTION,
  STATIC_OPENAI_DISPLAY_NAME,
  buildSubmissionFormData,
  canSubmitState,
  clampVariantCount,
  estimatePolish23CostPerVariantUsd,
  estimatePolish26CostPerVariantUsd,
  estimateStaticOpenaiCostPerVariantUsd,
  getDefaultProviderForModel,
  getSoleLauncherModel,
  type SimplifiedFormState,
  type StaticOpenaiQuality,
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
  // Polish-25.1 Commit 10b: Polish-25 (Instant UGC) is now the
  // DEFAULT selection on mount — the recommended primary pipeline
  // shouldn't require an extra click. If the user has the Instant
  // UGC keys connected, we start with polish26Selected=true and
  // everything else cleared. If they don't, we fall back to
  // soleModel so the form still has a picked state to submit
  // against.
  //
  // Polish-25.2 Commit 11: MakeUGC is platform-managed — the gate
  // now only checks Claude + Gemini BYOK. The MakeUGC key comes
  // from the MAKEUGC_MANAGED_KEY env var at worker submit time.
  // Polish-27.0.0 Commit 63: UGC surface nuked pre-Polish-28 rebuild.
  // polish23Selected + polish26Selected forced-false, canDefaultPolish26
  // gate disabled. The state variables + setters are RETAINED so the
  // rollback (Polish-28 Commit 64) is a one-line reversal per hook.
  // Every downstream branch that reads them (estimators, key gates,
  // pick handlers) is preserved as dead code — harmless because
  // polish*Selected can never become true post-Commit-63.
  const soleModel = getSoleLauncherModel();
  // canDefaultPolish26 was the gate that auto-picked the UGC card
  // pre-Commit-63; retained inline as a comment for the rollback
  // reference. Post-Commit-63 the card is a "Coming soon" placeholder,
  // so there's nothing to auto-pick.
  const [modelId, setModelId] = React.useState<VideoModelId | null>(
    soleModel ? soleModel.id : null,
  );
  const [polish23Selected, setPolish23Selected] = React.useState(false);
  const [polish26Selected, setPolish26Selected] = React.useState(false);
  // Polish-28.0.0 Commit 64: cloned-UGC card selection state.
  const [polish28Selected, setPolish28Selected] = React.useState(false);
  // Polish-28.3.0 Commit 86: variations-mode card selection state.
  // Default primary picker experience — most operators want N distinct
  // spokespeople, not one clone of the source actor.
  const [polish28VariationsSelected, setPolish28VariationsSelected] = React.useState(false);
  // Polish-25.3 Commit 18b: static ad picker + quality tier. Mutually
  // exclusive with polish23Selected + polish26Selected + modelId.
  // Defaults to Medium quality — matches the shipped cost line.
  const [staticOpenaiSelected, setStaticOpenaiSelected] = React.useState(false);
  const [staticOpenaiQuality, setStaticOpenaiQuality] = React.useState<StaticOpenaiQuality>(
    STATIC_OPENAI_DEFAULT_QUALITY,
  );
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
    polish26Selected,
    polish28Selected,
    polish28VariationsSelected,
    staticOpenaiSelected,
    staticOpenaiQuality,
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
  const polish26Estimate = polish26Selected
    ? { estimateUsd: variantCount * estimatePolish26CostPerVariantUsd(detectedSourceSeconds).usd }
    : null;
  // Polish-28.0.0 Commit 64: fixed per-variant BYOK cost from Phase 1
  // investigation ($2.23 per 30s video, dominated by HeyGen Avatar IV).
  const polish28Estimate = polish28Selected
    ? { estimateUsd: variantCount * estimatePolish28CostPerVariantUsd().usd }
    : null;
  // Polish-28.3.0 Commit 86: variations mode cost preview. Same
  // shape as clone mode but drops Replicate line (no source-frame
  // extract). ~$2.15/variant.
  const polish28VariationsEstimate = polish28VariationsSelected
    ? { estimateUsd: variantCount * estimatePolish28VariationsCostPerVariantUsd().usd }
    : null;
  // Polish-25.3 Commit 18b: static-openai cost preview per quality
  // tier. Fixed per-variant, no duration scaling (image, not video).
  const staticOpenaiEstimate = staticOpenaiSelected
    ? {
        estimateUsd: variantCount * estimateStaticOpenaiCostPerVariantUsd(staticOpenaiQuality).usd,
      }
    : null;
  const estimate = polish28VariationsEstimate
    ? polish28VariationsEstimate
    : polish28Estimate
      ? polish28Estimate
      : staticOpenaiEstimate
        ? staticOpenaiEstimate
        : polish26Estimate
          ? polish26Estimate
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

  // Polish-25 Commit 2 + Polish-25.2 Commit 11: Instant UGC gate.
  // Needs Claude (script condenser) + Gemini (concept vision
  // analysis via analyze-concept). MakeUGC is platform-managed
  // post-Commit-11 — no user key check.
  const polish26MissingKeys: string[] = [];
  if (!connectedProviders.claude.connected) polish26MissingKeys.push('Claude');
  if (!connectedProviders.gemini.connected) polish26MissingKeys.push('Gemini');
  const hasPolish26Keys = polish26MissingKeys.length === 0;

  // Polish-28.0.5 Commit 64.5: cloned-UGC key gate now 4 BYOK
  // (elevenlabs dropped in 28.2.0 — HeyGen native TTS).
  const polish28MissingKeys: string[] = [];
  if (!connectedProviders.claude.connected) polish28MissingKeys.push('Claude');
  if (!connectedProviders.gemini.connected) polish28MissingKeys.push('Gemini');
  if (!connectedProviders.heygen.connected) polish28MissingKeys.push('HeyGen');
  if (!connectedProviders.replicate.connected) polish28MissingKeys.push('Replicate');
  const hasPolish28Keys = polish28MissingKeys.length === 0;

  // Polish-28.3.0 Commit 86: variations gate — 3 BYOK (no Replicate,
  // no source-frame extract). Same 3 as clone minus Replicate.
  const polish28VariationsMissingKeys: string[] = [];
  if (!connectedProviders.claude.connected) polish28VariationsMissingKeys.push('Claude');
  if (!connectedProviders.gemini.connected) polish28VariationsMissingKeys.push('Gemini');
  if (!connectedProviders.heygen.connected) polish28VariationsMissingKeys.push('HeyGen');
  const hasPolish28VariationsKeys = polish28VariationsMissingKeys.length === 0;

  // Polish-25.3 Commit 18b: static-openai gate. Needs Claude
  // (copy rewrite) + OpenAI (gpt-image-2). Gemini optional (source
  // vision analysis is skipped for the static path). Missing keys
  // surface in the disabled-Generate tooltip + inline nudge.
  const staticOpenaiMissingKeys: string[] = [];
  if (!connectedProviders.claude.connected) staticOpenaiMissingKeys.push('Claude');
  if (!connectedProviders.openai.connected) staticOpenaiMissingKeys.push('OpenAI');
  const hasStaticOpenaiKeys = staticOpenaiMissingKeys.length === 0;

  const legacyMissingKeys: string[] = [];
  if (!hasHedraKey) legacyMissingKeys.push('Hedra');
  if (!hasElevenLabsKey) legacyMissingKeys.push('ElevenLabs');
  const hasLegacyKeys = hasHedraKey && hasElevenLabsKey;

  const hasProviderKey = polish28VariationsSelected
    ? hasPolish28VariationsKeys
    : polish28Selected
      ? hasPolish28Keys
      : staticOpenaiSelected
        ? hasStaticOpenaiKeys
        : polish26Selected
          ? hasPolish26Keys
          : polish23Selected
            ? hasPolish23Keys
            : hasLegacyKeys;
  const missingKeys = polish28VariationsSelected
    ? polish28VariationsMissingKeys
    : polish28Selected
      ? polish28MissingKeys
      : staticOpenaiSelected
        ? staticOpenaiMissingKeys
        : polish26Selected
          ? polish26MissingKeys
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
      {/* Source preview — Polish-25.2 Commit 12: video-only, no
          text placeholder. If we don't have a preview URL (e.g. a
          static-image concept) skip the section entirely instead
          of showing empty-state copy. */}
      {sourcePreviewUrl && (
        <section className="border-border bg-bg-surface rounded-md border p-4">
          <div className="text-fg-subtle mb-3 text-xs font-semibold uppercase tracking-wider">
            Source
          </div>
          <video
            src={sourcePreviewUrl}
            className="bg-bg-inset block max-h-96 w-full rounded object-contain"
            muted
            controls
            playsInline
          />
        </section>
      )}

      {/* Polish-28.3.0 Commit 86: PRIMARY variations card. Dispatches
          the polish28_variations_ugc pipeline — N distinct personas +
          N script variations from the source ad's offer. Meta A/B-test
          pattern. 3-BYOK (no Replicate). */}
      <Polish28VariationsPickerCard
        picked={polish28VariationsSelected}
        disabled={isPending}
        missingKeys={polish28VariationsMissingKeys}
        onPick={() => {
          setPolish28VariationsSelected(true);
          setPolish28Selected(false);
          setStaticOpenaiSelected(false);
          setPolish26Selected(false);
          setPolish23Selected(false);
          setModelId(null);
        }}
      />

      {/* Polish-28.0.0 Commit 64: SECONDARY "Instant UGC (Cloned)" card.
          Dispatches the polish28_clone_ugc pipeline — one video that
          replicates the source ad's exact actor. Kept alongside the
          variations card in Commit 86 for the "clone this specific ad"
          use case. 4-BYOK (Claude + Gemini + HeyGen + Replicate). */}
      <Polish28PickerCard
        picked={polish28Selected}
        disabled={isPending}
        missingKeys={polish28MissingKeys}
        onPick={() => {
          setPolish28Selected(true);
          setPolish28VariationsSelected(false);
          setStaticOpenaiSelected(false);
          setPolish26Selected(false);
          setPolish23Selected(false);
          setModelId(null);
        }}
      />

      {/* Polish-25.3 Commit 18b: Static ad picker. Rendered next to
          Instant UGC. Reveals a low/medium/high quality selector when
          picked. Card body describes the reference-image edit flow so
          the operator understands what OpenAI does (vs. the video-
          only Instant UGC card). Mutually exclusive with Polish-25 +
          Polish-23 + modelId. */}
      <StaticOpenaiPickerCard
        picked={staticOpenaiSelected}
        disabled={isPending}
        quality={staticOpenaiQuality}
        onPick={() => {
          setStaticOpenaiSelected(true);
          setPolish26Selected(false);
          setPolish23Selected(false);
          setPolish28Selected(false);
          setPolish28VariationsSelected(false);
          setModelId(null);
        }}
        onQualityChange={setStaticOpenaiQuality}
      />

      {/* Polish-25.2 Commit 12: model picker hidden for MVP. Only
          Instant UGC is user-visible. Alternate pipelines
          (Higgsfield UGC, Hedra, Sora, Nano Banana) stay wired in
          the backend + will surface in a future release with a
          proper picker + BYOK prompts. */}

      {/* Polish-25.2 Commit 12: variant-count only. Length section
          removed - duration always auto-detected from the source
          video (client detection → worker fallback chain). Advanced-
          form link removed too. */}
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

      {/* Polish-25.2 Commit 12: cost estimate visually anchored —
          larger + bolder headline number. Breakdown lives inside a
          <details> collapse so users can see per-provider cost
          detail without it competing with the total. Cost is
          computed from the actual detected source duration; falls
          back to the shared default only until detection completes. */}
      <div
        className={cn(
          'border-border bg-bg-surface rounded-md border px-4 py-4',
          overCap && 'border-[color:var(--accent-negative)]/60',
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-fg-muted text-sm">Estimated cost</span>
          {/* Polish-25.2 Commit 17: dollar figure rendered in the
              positive-accent green when the estimate is valid + not
              over cap. Money-signal — reads as "cheap, safe to
              proceed" at a glance. Falls back to text-fg on over-cap
              so the number pairs visually with the red warning
              beneath it. */}
          <span
            className={cn(
              'font-mono text-2xl font-semibold tracking-tight',
              estimate && !overCap ? 'text-[color:var(--accent-positive)]' : 'text-fg',
            )}
          >
            {estimate ? `$${estimate.estimateUsd.toFixed(2)}` : '-'}
          </span>
        </div>
        {estimate != null && (
          <p className="text-fg-subtle mt-1 text-xs">
            {variantCount} variation{variantCount === 1 ? '' : 's'} · {previewSeconds}s each
            {detectionPending && ' · preview at 30s default until source analysis completes'}
          </p>
        )}

        <details className="group mt-3">
          <summary className="text-fg-muted hover:text-fg cursor-pointer list-none text-xs transition-colors">
            Cost breakdown
            <span className="text-fg-subtle ml-1 group-open:hidden">▸</span>
            <span className="text-fg-subtle ml-1 hidden group-open:inline">▾</span>
          </summary>
          <ul className="border-border-subtle mt-2 space-y-1 border-t pt-2 text-xs">
            <li className="flex items-baseline justify-between gap-3">
              <span className="text-fg-muted">Instant UGC render</span>
              <span className="text-fg font-mono">Included</span>
            </li>
            <li className="flex items-baseline justify-between gap-3">
              <span className="text-fg-muted">Claude script condense</span>
              <span className="text-fg font-mono">~$0.02 / variant</span>
            </li>
            <li className="flex items-baseline justify-between gap-3">
              <span className="text-fg-muted">Gemini vision (concept + avatar match)</span>
              <span className="text-fg font-mono">~$0.05 / variant</span>
            </li>
          </ul>
        </details>

        {overCap && (
          <p className="mt-3 text-xs text-[color:var(--accent-negative)]">
            Over your remaining daily cap (${remaining.toFixed(2)} left). Raise the cap in Settings
            or reduce variants.
          </p>
        )}
        {/* Polish-25.9 Commit 57: added staticOpenaiSelected to the
            condition. Pre-Commit-57 the Static ad pipeline silently
            disabled Generate when OpenAI wasn't connected because
            this inline nudge only checked the three other pickers.
            User read "greyed-out button with no visible error" and
            couldn't figure out the OpenAI-key requirement. */}
        {!hasProviderKey &&
          (modelId != null || polish23Selected || polish26Selected || staticOpenaiSelected) && (
            <p className="mt-3 text-xs text-[color:var(--accent-negative)]">
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
        {/* Polish-25.8 Commit 55: silent-disable fix. Pre-Commit-55,
            when the user hadn't yet picked a model the Generate
            button greyed out with no inline reason (only a hover
            tooltip, invisible on mobile). This paragraph makes the
            gate visible. */}
        {!canSubmit && !overCap && (
          <p className="text-fg-muted mt-3 text-xs">
            {/* Polish-27.0.0 Commit 63: only Static ad is live pre-Polish-28
                rebuild — the hint no longer mentions Instant UGC / Higgsfield. */}
            Pick Static ad above to enable Generate. Custom UGC returns in the next release.
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
          variant="accent"
          size="lg"
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
              {estimate ? `$${estimate.estimateUsd.toFixed(2)}` : '-'}. You only see this dialog
              once.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" variant="accent" onClick={confirmLiveDialog} disabled={isPending}>
              I understand, generate
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}

/**
 * Polish-27.0.0 Commit 63: Polish26PickerCard component + its
 * Polish26PickerCardProps interface removed —
 * TS6133 unused-symbol rule doesn't tolerate a defined-but-unused
 * component. The card's markup + props interface Polish26PickerCardProps
 * remain resurrectable via git history when Polish-28 (Commit 64)
 * restores the Custom UGC surface. See git log --diff-filter=D --
 * apps/web/app/concepts/[id]/generate/simplified-form.tsx for the
 * pre-Commit-63 shape.
 */

// Polish-25.2 Commit 12: Polish23PickerCard + ModelCard components
// removed. They were only referenced from the "Change model"
// dropdown, which is hidden for MVP. Backend descriptors +
// pipeline routing stay intact; when the model picker returns,
// these components come back with them.

// -------------------------------------------------------------------
// Polish-25.3 Commit 18b: Static ad picker card
// -------------------------------------------------------------------

interface StaticOpenaiPickerCardProps {
  picked: boolean;
  disabled: boolean;
  quality: StaticOpenaiQuality;
  onPick: () => void;
  onQualityChange: (q: StaticOpenaiQuality) => void;
}

/**
 * Static ad picker card. Reveals a low/medium/high quality
 * selector when picked so the operator can trade cost vs.
 * fidelity before submitting. Copy explains what the pipeline
 * actually does (reference-image edit via OpenAI gpt-image-2 +
 * Claude overlay-copy rewrite) so the operator understands the
 * flow without reading docs.
 */
function StaticOpenaiPickerCard({
  picked,
  disabled,
  quality,
  onPick,
  onQualityChange,
}: StaticOpenaiPickerCardProps) {
  return (
    <div
      className={cn(
        'group relative w-full rounded-md border p-4 text-left transition-colors',
        picked ? 'border-fg bg-fg/5' : 'border-border bg-bg-surface hover:border-fg/50',
        disabled && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        aria-pressed={picked}
        className={cn('flex w-full flex-col gap-2 text-left', disabled && 'cursor-not-allowed')}
      >
        {picked && (
          <CheckCircle2 className="text-fg absolute right-3 top-3 h-4 w-4" aria-hidden="true" />
        )}
        {/* Polish-25.3 Commit 23: Beta tag so operators set the right
            quality expectation before spending. Static pipeline works
            end-to-end but copy quality is still being tuned (see
            Commit 20/21/22 iteration history). Not gated — just
            labeled. */}
        <div className="flex items-center gap-2">
          <div className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">
            Static ad
          </div>
          <span
            className="border-[color:var(--accent-warning,#a68a00)]/40 bg-[color:var(--accent-warning,#a68a00)]/10 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[color:var(--accent-warning,#a68a00)]"
            aria-label="Beta feature"
          >
            Beta
          </span>
        </div>
        <div className="text-fg text-sm font-semibold">{STATIC_OPENAI_DISPLAY_NAME}</div>
        <div className="text-fg-muted text-xs leading-relaxed">{STATIC_OPENAI_DESCRIPTION}</div>
        <div className="text-fg-subtle mt-1 text-[11px] italic leading-relaxed">
          Copy quality varies. Edit outputs before launching.
        </div>
      </button>

      {picked && (
        <div className="border-border-subtle mt-3 border-t pt-3">
          <div className="text-fg-subtle mb-1.5 text-[10px] font-semibold uppercase tracking-wider">
            Image quality
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Image quality">
            {(['low', 'medium', 'high'] as StaticOpenaiQuality[]).map((q) => {
              // 18b-hotfix: verified July 2026 gpt-image-2 pricing.
              const priceLabel = q === 'high' ? '$0.211' : q === 'medium' ? '$0.053' : '$0.006';
              return (
                <button
                  key={q}
                  type="button"
                  role="radio"
                  aria-checked={quality === q}
                  onClick={() => onQualityChange(q)}
                  disabled={disabled}
                  className={cn(
                    'min-w-[6rem] flex-1 rounded-md border px-3 py-2 text-xs transition-colors',
                    quality === q
                      ? 'border-fg bg-fg/10 text-fg font-medium'
                      : 'border-border text-fg-muted hover:border-fg/50 hover:text-fg',
                    disabled && 'cursor-not-allowed',
                  )}
                >
                  <div className="capitalize">{q}</div>
                  <div className="text-fg-subtle mt-0.5 font-mono">{priceLabel}/img</div>
                </button>
              );
            })}
          </div>
          <p className="text-fg-subtle mt-2 text-[11px]">
            Medium is the recommended default. Matches Instant UGC per-variant cost.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Polish-28.0.0 Commit 64: cloned-UGC picker card. Active successor
 * to the pre-nuke Polish26PickerCard. Displays the four required
 * BYOK providers + the fixed per-30s cost ($2.23). Missing-key
 * warning surfaces inline so users see exactly which key to connect.
 */
interface Polish28PickerCardProps {
  picked: boolean;
  disabled: boolean;
  missingKeys: string[];
  onPick: () => void;
}

function Polish28PickerCard({ picked, disabled, missingKeys, onPick }: Polish28PickerCardProps) {
  const canPick = missingKeys.length === 0;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled || !canPick}
      aria-pressed={picked}
      className={cn(
        'group relative flex w-full flex-col gap-2 rounded-md border p-4 text-left transition-colors',
        picked
          ? 'border-fg bg-fg/5'
          : 'border-[color:var(--accent-positive)]/50 bg-bg-surface hover:border-fg/50',
        (disabled || !canPick) && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'absolute right-3 top-3 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
          'bg-[color:var(--accent-positive)]/15 text-[color:var(--accent-positive)]',
        )}
      >
        BYOK - Recommended
      </span>
      {picked && (
        <CheckCircle2 className="text-fg absolute right-28 top-3 h-4 w-4" aria-hidden="true" />
      )}
      <div className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">
        Instant UGC (Cloned)
      </div>
      <div className="text-fg text-sm font-semibold">{POLISH28_DISPLAY_NAME}</div>
      <div className="text-fg-muted text-xs leading-relaxed">{POLISH28_DESCRIPTION}</div>
      <div className="text-fg-subtle mt-1 text-[11px]">Output: 9:16 vertical (Reels/TikTok)</div>
      {!canPick && (
        <div className="mt-2 text-xs text-[color:var(--accent-negative)]">
          Connect {missingKeys.join(' + ')} at{' '}
          <Link
            href="/settings/connections"
            className="underline underline-offset-4"
            onClick={(e) => e.stopPropagation()}
          >
            Settings → Connections
          </Link>{' '}
          to unlock.
        </div>
      )}
    </button>
  );
}

// Polish-28.3.0 Commit 86: variations picker card. Sibling of
// Polish28PickerCard but with distinct copy, cost line, and BYOK
// requirement (3 keys not 4 — no Replicate).
interface Polish28VariationsPickerCardProps {
  picked: boolean;
  disabled: boolean;
  missingKeys: string[];
  onPick: () => void;
}

function Polish28VariationsPickerCard({
  picked,
  disabled,
  missingKeys,
  onPick,
}: Polish28VariationsPickerCardProps) {
  const canPick = missingKeys.length === 0;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled || !canPick}
      aria-pressed={picked}
      className={cn(
        'group relative flex w-full flex-col gap-2 rounded-md border p-4 text-left transition-colors',
        picked
          ? 'border-fg bg-fg/5'
          : 'border-[color:var(--accent-positive)]/50 bg-bg-surface hover:border-fg/50',
        (disabled || !canPick) && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'absolute right-3 top-3 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
          'bg-[color:var(--accent-positive)]/15 text-[color:var(--accent-positive)]',
        )}
      >
        BYOK - Recommended
      </span>
      {picked && (
        <CheckCircle2 className="text-fg absolute right-28 top-3 h-4 w-4" aria-hidden="true" />
      )}
      <div className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">
        Instant UGC (Variations)
      </div>
      <div className="text-fg text-sm font-semibold">{POLISH28_VARIATIONS_DISPLAY_NAME}</div>
      <div className="text-fg-muted text-xs leading-relaxed">{POLISH28_VARIATIONS_DESCRIPTION}</div>
      <div className="text-fg-subtle mt-1 text-[11px]">
        Output: N × 9:16 vertical (each ~$
        {estimatePolish28VariationsCostPerVariantUsd().usd.toFixed(2)})
      </div>
      {!canPick && (
        <div className="mt-2 text-xs text-[color:var(--accent-negative)]">
          Connect {missingKeys.join(' + ')} at{' '}
          <Link
            href="/settings/connections"
            className="underline underline-offset-4"
            onClick={(e) => e.stopPropagation()}
          >
            Settings → Connections
          </Link>{' '}
          to unlock.
        </div>
      )}
    </button>
  );
}
