'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_VARIANTS_PER_JOB,
  estimateGenerationCost,
  type ConceptType,
  type CreativeFormat,
} from '@mbb/shared';
import { Badge } from '@/components/ui/badge';
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
import { type ConnectedProviders, createGenerationJobAction } from './actions';

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

  // Polish-4: format picker. cinematic_voiceover requires kling + elevenlabs.
  const cinematicReady =
    connectedProviders.kling.connected && connectedProviders.elevenlabs.connected;
  const heygenReady = connectedProviders.heygen.connected;
  const defaultFormat: CreativeFormat = heygenReady
    ? 'avatar_talking_head'
    : cinematicReady
      ? 'cinematic_voiceover'
      : 'avatar_talking_head';
  const [format, setFormat] = React.useState<CreativeFormat>(defaultFormat);

  const estimate = React.useMemo(
    () =>
      estimateGenerationCost({
        conceptType,
        variantCount: Math.max(1, Math.min(MAX_VARIANTS_PER_JOB, variantCount || 1)),
        provider: conceptType === 'ugc' ? 'heygen' : undefined,
        format: conceptType === 'ugc' ? format : undefined,
      }),
    [conceptType, variantCount, format],
  );

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

      {/* Polish-4: Format picker (UGC only). Two creative formats:
          avatar_talking_head (HeyGen) and cinematic_voiceover (Kling +
          ElevenLabs). Options that the user doesn't have keys for are
          disabled with an inline CTA to /connections/ai-provider. */}
      {conceptType === 'ugc' && (
        <fieldset className="space-y-2">
          <legend className="text-fg text-sm font-medium">Format</legend>
          <FormatRadio
            value="avatar_talking_head"
            checked={format === 'avatar_talking_head'}
            onSelect={() => setFormat('avatar_talking_head')}
            disabled={!heygenReady}
            label="Avatar talking head"
            description="HeyGen Avatar Mode — Claude casts a different avatar per variant from your HeyGen pool."
            badge={
              connectedProviders.heygen.tier ? (
                <Badge variant="outline">{connectedProviders.heygen.tier}</Badge>
              ) : null
            }
            disabledHint="Connect HeyGen on /connections/ai-provider."
          />
          <FormatRadio
            value="cinematic_voiceover"
            checked={format === 'cinematic_voiceover'}
            onSelect={() => setFormat('cinematic_voiceover')}
            disabled={!cinematicReady}
            label="Cinematic voiceover"
            description="Kling 2.5 generates a cinematic 5s clip; ElevenLabs reads your script as voiceover. No on-screen actor."
            disabledHint={
              connectedProviders.kling.connected
                ? 'Connect ElevenLabs on /connections/ai-provider for the voiceover.'
                : 'Connect Kling (Replicate) + ElevenLabs on /connections/ai-provider.'
            }
          />
        </fieldset>
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

      {/* Polish-4: provider-availability hint if user has connected
          neither HeyGen nor Kling. Without keys the submit always fails. */}
      {conceptType === 'ugc' && !heygenReady && !cinematicReady && (
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

interface FormatRadioProps {
  value: CreativeFormat;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  label: string;
  description: string;
  badge?: React.ReactNode;
  disabledHint?: string;
}

function FormatRadio({
  value,
  checked,
  onSelect,
  disabled,
  label,
  description,
  badge,
  disabledHint,
}: FormatRadioProps) {
  return (
    <label
      className={
        'flex cursor-pointer items-start gap-3 rounded-md border p-4 transition-colors ' +
        (disabled
          ? 'bg-bg-elevated text-fg-muted cursor-not-allowed opacity-60'
          : checked
            ? 'border-fg-muted bg-bg-hover'
            : 'bg-bg-elevated hover:bg-bg-hover')
      }
    >
      <input
        type="radio"
        name="format"
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-1 h-4 w-4"
      />
      <span className="flex-1">
        <span className="text-fg flex items-center gap-2 font-medium">
          {label}
          {badge}
        </span>
        <span className="text-fg-muted mt-0.5 block text-sm">{description}</span>
        {disabled && disabledHint && (
          <span className="text-fg-muted mt-1 block text-xs italic">{disabledHint}</span>
        )}
      </span>
    </label>
  );
}
