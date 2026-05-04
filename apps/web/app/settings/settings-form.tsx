'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { SettingsFormSchema, type SettingsFormInput } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { saveSettingsAction } from './actions';

interface Props {
  initialValues: SettingsFormInput;
  hardCeiling: number;
}

interface ToastState {
  variant: 'success' | 'info' | 'error';
  message: string;
}

/** One field config = label + help text + zod-driven type. Ordering matters. */
const FIELDS: Array<{
  name: keyof SettingsFormInput;
  label: string;
  help: string;
  type: 'number' | 'integer' | 'currency' | 'percent' | 'enum-cbo-abo' | 'boolean';
}> = [
  // --- Test budget ---
  {
    name: 'defaultTestCap',
    label: 'Default test cap',
    help: 'USD per ad set when first launched. Variants compete inside this budget.',
    type: 'currency',
  },
  {
    name: 'adSetsPerLaunch',
    label: 'Ad sets per launch',
    help: 'How many ad sets to spin up per generation batch. 5 is a sane default.',
    type: 'integer',
  },
  {
    name: 'dailyGenerationVolume',
    label: 'Daily generation volume',
    help: 'How many AI variants to produce per day across all concepts.',
    type: 'integer',
  },
  {
    name: 'campaignObjective',
    label: 'Campaign objective',
    help: 'CBO = Meta optimizes budget across ad sets. ABO = each ad set has its own budget.',
    type: 'enum-cbo-abo',
  },
  // --- Kill logic ---
  {
    name: 'killThresholdCpc',
    label: 'CPC kill ceiling',
    help: 'Above this CPC (and CTR low), the bot kills the ad. USD.',
    type: 'currency',
  },
  {
    name: 'killThresholdCtr',
    label: 'CTR kill floor',
    help: 'Below this CTR (and CPC high), the bot kills the ad. Percent.',
    type: 'percent',
  },
  {
    name: 'gracePeriodMinutes',
    label: 'Grace period (minutes)',
    help: 'When CPC is high but CTR is OK, wait this long before re-checking.',
    type: 'integer',
  },
  {
    name: 'hour6CutoffEnabled',
    label: 'Hour 6 cutoff',
    help: 'Kill ads that have zero conversions by hour 6, even if CPC/CTR look fine.',
    type: 'boolean',
  },
  // --- Scale logic ---
  {
    name: 'scaleTier1Cap',
    label: 'Scale tier 1 cap',
    help: 'Auto-scale survivors to this daily budget. USD.',
    type: 'currency',
  },
  {
    name: 'scaleTier2Cap',
    label: 'Scale tier 2 cap',
    help: 'Auto-scale tier 1 winners to this daily budget. USD.',
    type: 'currency',
  },
  {
    name: 'manualApprovalThreshold',
    label: 'Manual approval threshold',
    help: 'Above this daily budget, the bot pings you on Telegram before scaling further. USD.',
    type: 'currency',
  },
  // --- Safety ---
  {
    name: 'platformDailySpendCeiling',
    label: 'Daily spend ceiling',
    help: 'Hard cap on per-day spend across all your ad accounts. USD.',
    type: 'currency',
  },
];

export function SettingsForm({ initialValues, hardCeiling }: Props) {
  const form = useForm<SettingsFormInput>({
    resolver: zodResolver(SettingsFormSchema),
    defaultValues: initialValues,
    mode: 'onBlur',
  });
  const [toast, setToast] = React.useState<ToastState | null>(null);
  const [pending, startTransition] = React.useTransition();

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      setToast(null);
      const result = await saveSettingsAction(values);
      if (!result.ok) {
        if (result.fieldErrors) {
          for (const [field, message] of Object.entries(result.fieldErrors)) {
            form.setError(field as keyof SettingsFormInput, { type: 'server', message });
          }
        }
        setToast({ variant: 'error', message: result.errorMessage ?? 'Save failed.' });
        return;
      }
      if (result.changedCount === 0) {
        setToast({ variant: 'info', message: 'No changes to save.' });
        return;
      }
      setToast({
        variant: 'success',
        message: `Saved ${result.changedCount} change${result.changedCount === 1 ? '' : 's'}.`,
      });
      // Reset RHF dirty state to the new values so the diff helper on the
      // next submit compares against the latest saved snapshot.
      form.reset(values);
    });
  });

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {FIELDS.map((field) => {
        const error = form.formState.errors[field.name];
        return (
          <div key={field.name} className="space-y-1.5">
            <Label htmlFor={field.name}>{field.label}</Label>
            <p className="text-muted-foreground text-xs">{field.help}</p>

            {field.type === 'enum-cbo-abo' && (
              <select
                id={field.name}
                {...form.register(field.name)}
                className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
              >
                <option value="CBO">CBO — campaign-budget optimization</option>
                <option value="ABO">ABO — ad-set budget optimization</option>
              </select>
            )}

            {field.type === 'boolean' && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  id={field.name}
                  {...form.register(field.name)}
                  className="border-input h-4 w-4 rounded"
                />
                <span>Enabled</span>
              </label>
            )}

            {(field.type === 'number' ||
              field.type === 'integer' ||
              field.type === 'currency' ||
              field.type === 'percent') && (
              <div className="relative">
                {field.type === 'currency' && (
                  <span className="text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 text-sm">
                    $
                  </span>
                )}
                <Input
                  id={field.name}
                  type="number"
                  step={field.type === 'currency' ? '0.01' : field.type === 'percent' ? '0.1' : '1'}
                  inputMode="decimal"
                  {...form.register(field.name)}
                  className={field.type === 'currency' ? 'pl-7' : undefined}
                />
                {field.type === 'percent' && (
                  <span className="text-muted-foreground absolute right-3 top-1/2 -translate-y-1/2 text-sm">
                    %
                  </span>
                )}
              </div>
            )}

            {field.name === 'platformDailySpendCeiling' && (
              <p className="text-muted-foreground text-xs">
                Platform hard ceiling: <strong>${hardCeiling}</strong>. Even if you enter a higher
                number, the platform clamps to this.
              </p>
            )}

            {error && <p className="text-destructive text-xs">{error.message}</p>}
          </div>
        );
      })}

      {toast && (
        <div
          className={
            toast.variant === 'error'
              ? 'border-destructive/50 bg-destructive/5 text-destructive rounded-md border p-3 text-sm'
              : toast.variant === 'success'
                ? 'rounded-md border border-green-500/40 bg-green-500/5 p-3 text-sm text-green-700'
                : 'bg-muted text-muted-foreground rounded-md border p-3 text-sm'
          }
        >
          {toast.message}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <Button type="submit" disabled={pending} size="lg">
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
}
