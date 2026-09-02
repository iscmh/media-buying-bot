import { getModelCostPreview } from '@mbb/ai-providers';
import { savingsPct } from '@mbb/shared';
import { Coins } from 'lucide-react';

/**
 * Polish-29.0.3 Commit 113: pre-submit cost preview badge.
 *
 * Render inline next to the submit button on any generation form:
 *
 *   <CostPreviewBadge modelId="seedance-2-5-ugc" balance={2500} />
 *   → "40 credits ($0.80) — save 82%"
 *   <CostPreviewBadge modelId="heygen-avatar-iv" balance={2500} />
 *   → "Uses your HeyGen API key"
 *
 * Server component — reads the shared catalog once at render, no
 * client-side JS shipped. Returns null for unknown model ids so
 * callers can pass a form-driven value without conditional wrapping.
 */

export interface CostPreviewBadgeProps {
  modelId: string;
  /** Optional — enables the "insufficient balance" warning tone. */
  balance?: number;
  className?: string;
}

export function CostPreviewBadge({ modelId, balance, className }: CostPreviewBadgeProps) {
  const preview = getModelCostPreview(modelId);
  if (!preview) return null;

  if (preview.mode === 'byok') {
    return (
      <span
        className={
          'text-fg-muted border-border bg-bg-surface inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ' +
          (className ?? '')
        }
      >
        BYOK — uses your {providerShortName(preview.modelId)} key
      </span>
    );
  }

  const insufficient = typeof balance === 'number' && balance < preview.credits;
  const savings = savingsPct({
    id: preview.modelId,
    displayName: preview.displayName,
    // The shared savingsPct helper only reads .mode + .credits + .retailUsdPerAction —
    // the rest of the CreditModel shape doesn't affect the calculation. Cast for
    // brevity; if the helper's contract ever widens, TS will surface it.
    mode: preview.mode,
    credits: preview.credits,
    retailUsdPerAction: preview.retailUsdPerAction,
    description: '',
    provider: 'useapi.seedance',
    family: 'ugc',
    qualityTier: 'balanced',
  });

  const dollar = preview.userDollarCost.toFixed(2);

  return (
    <span
      className={
        (insufficient
          ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300'
          : 'text-fg-muted border-border bg-bg-surface') +
        ' inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]' +
        (className ?? '')
      }
      aria-label={
        insufficient
          ? `Insufficient balance: needs ${preview.credits} credits, you have ${balance}`
          : `Will cost ${preview.credits} credits ($${dollar})`
      }
    >
      <Coins className="h-3 w-3" aria-hidden="true" />
      <span className="tabular-nums">
        {preview.credits} credits <span className="opacity-70">(${dollar})</span>
      </span>
      {savings > 0 && !insufficient && (
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          · save {savings}%
        </span>
      )}
      {insufficient && (
        <span className="font-medium">· need {preview.credits - (balance ?? 0)} more</span>
      )}
    </span>
  );
}

function providerShortName(modelId: string): string {
  if (modelId.startsWith('heygen')) return 'HeyGen';
  if (modelId.startsWith('openai')) return 'OpenAI';
  if (modelId.startsWith('claude')) return 'Anthropic';
  if (modelId.startsWith('elevenlabs')) return 'ElevenLabs';
  return 'provider';
}
