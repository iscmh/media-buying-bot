'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  META_OPTIMIZATION_GOALS,
  META_PLACEMENT_TYPES,
  SUPPORTED_TARGETING_COUNTRIES,
  SettingsFormSchema,
  TIMEZONE_PICKER_GROUPS,
  type SettingsFormInput,
} from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { saveSettingsAction } from './actions';

interface Props {
  initialValues: SettingsFormInput;
  hardCeiling: number;
  aiHardCeiling: number;
  launchHardCeiling: number;
  adDailyHardCeiling: number;
  metaPages: Array<{ pageId: string; pageName: string }>;
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
  type:
    | 'number'
    | 'integer'
    | 'currency'
    | 'percent'
    | 'enum-cbo-abo'
    | 'enum-optimization-goal'
    | 'enum-placement-type'
    | 'enum-page'
    | 'multi-country'
    | 'boolean'
    | 'timezone';
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
  {
    name: 'aiGenerationDailyCapUsd',
    label: 'AI generation daily cap',
    help: 'Hard cap on per-day AI generation costs (Gemini, Claude, Kie.ai, HeyGen, Arcads). USD.',
    type: 'currency',
  },
  // --- Launch defaults (Phase 4a) ---
  {
    name: 'dailyLaunchBudgetCapUsd',
    label: 'Daily launch budget cap',
    help: 'Hard cap on per-day total daily budget committed when launching approved variants to Meta. USD.',
    type: 'currency',
  },
  {
    name: 'defaultAdDailyBudgetUsd',
    label: 'Default per-ad daily budget',
    help: 'Default daily budget per launched ad. Used unless overridden at launch time. USD.',
    type: 'currency',
  },
  {
    name: 'defaultOptimizationGoal',
    label: 'Default optimization goal',
    help: 'Meta optimization goal applied to new ad sets at launch.',
    type: 'enum-optimization-goal',
  },
  {
    name: 'defaultPlacementType',
    label: 'Default placement type',
    help: 'Advantage+ lets Meta auto-place; manual restricts placements per ad set.',
    type: 'enum-placement-type',
  },
  // --- Meta launch targeting defaults (Phase 4b) ---
  {
    name: 'defaultPageId',
    label: 'Default Facebook Page',
    help: 'Page that runs your ads. Pulled from /me/accounts when you connect Meta.',
    type: 'enum-page',
  },
  {
    name: 'defaultTargetingCountries',
    label: 'Default targeting countries',
    help: 'ISO 3166-1 codes. At least one required. Can be overridden per launch.',
    type: 'multi-country',
  },
  {
    name: 'defaultAgeMin',
    label: 'Default min age',
    help: 'Minimum audience age. Meta minimum is 13; we recommend 18.',
    type: 'integer',
  },
  {
    name: 'defaultAgeMax',
    label: 'Default max age',
    help: 'Maximum audience age. Must be ≥ min age.',
    type: 'integer',
  },
  // --- Daily summaries ---
  {
    name: 'timezone',
    label: 'Timezone',
    help: 'Daily P&L summaries arrive at midnight in this timezone.',
    type: 'timezone',
  },
];

export function SettingsForm({
  initialValues,
  hardCeiling,
  aiHardCeiling,
  launchHardCeiling,
  adDailyHardCeiling,
  metaPages,
}: Props) {
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

            {field.type === 'enum-optimization-goal' && (
              <select
                id={field.name}
                {...form.register(field.name)}
                className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
              >
                {META_OPTIMIZATION_GOALS.map((goal) => (
                  <option key={goal} value={goal}>
                    {goal}
                  </option>
                ))}
              </select>
            )}

            {field.type === 'enum-placement-type' && (
              <select
                id={field.name}
                {...form.register(field.name)}
                className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
              >
                {META_PLACEMENT_TYPES.map((p) => (
                  <option key={p} value={p}>
                    {p === 'advantage_plus' ? 'Advantage+ (auto placements)' : 'Manual placements'}
                  </option>
                ))}
              </select>
            )}

            {field.type === 'enum-page' &&
              (metaPages.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No Facebook Pages cached yet. Reconnect Meta or run a Live launch — pages refresh
                  on demand.
                </p>
              ) : (
                <select
                  id={field.name}
                  {...form.register(field.name)}
                  className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                >
                  <option value="">— Select a page —</option>
                  {metaPages.map((p) => (
                    <option key={p.pageId} value={p.pageId}>
                      {p.pageName} ({p.pageId})
                    </option>
                  ))}
                </select>
              ))}

            {field.type === 'multi-country' && (
              <CountryMultiSelect
                value={(form.watch('defaultTargetingCountries') as string[] | undefined) ?? []}
                onChange={(next) =>
                  form.setValue('defaultTargetingCountries', next, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
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

            {field.type === 'timezone' && (
              <TimezoneField
                name={field.name}
                value={form.watch(field.name) as string}
                onChange={(tz) =>
                  form.setValue(field.name, tz, { shouldDirty: true, shouldValidate: true })
                }
              />
            )}

            {field.name === 'platformDailySpendCeiling' && (
              <p className="text-muted-foreground text-xs">
                Platform hard ceiling: <strong>${hardCeiling}</strong>. Even if you enter a higher
                number, the platform clamps to this.
              </p>
            )}
            {field.name === 'aiGenerationDailyCapUsd' && (
              <p className="text-muted-foreground text-xs">
                Platform hard ceiling: <strong>${aiHardCeiling}</strong>. Generation jobs that would
                exceed this are blocked server-side.
              </p>
            )}
            {field.name === 'dailyLaunchBudgetCapUsd' && (
              <p className="text-muted-foreground text-xs">
                Platform hard ceiling: <strong>${launchHardCeiling}</strong>. Launches that would
                exceed today&apos;s committed total are blocked server-side.
              </p>
            )}
            {field.name === 'defaultAdDailyBudgetUsd' && (
              <p className="text-muted-foreground text-xs">
                Per-ad hard ceiling: <strong>${adDailyHardCeiling}</strong>. Server clamps higher
                values silently.
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

interface TimezoneFieldProps {
  name: string;
  value: string;
  onChange: (tz: string) => void;
}

/**
 * Region-grouped <select> for IANA timezones + a "Use detected"
 * suggestion when the browser-detected timezone differs from the saved
 * one. Detected via Intl.DateTimeFormat — runs only on the client (SSR
 * pass leaves the value at the saved one).
 */
function TimezoneField({ name, value, onChange }: TimezoneFieldProps) {
  const [browserTz, setBrowserTz] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected) setBrowserTz(detected);
    } catch {
      // Some embedded browsers don't surface this; leave null.
    }
  }, []);

  const showSuggestion = browserTz && browserTz !== value;

  return (
    <div className="space-y-2">
      <select
        id={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
      >
        {TIMEZONE_PICKER_GROUPS.map((group) => (
          <optgroup key={group.region} label={group.region}>
            {group.zones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </optgroup>
        ))}
        {/* If the saved value isn't in the picker (e.g. set via API to an
            obscure but valid IANA zone), keep it visible so it's not
            silently overwritten on next save. */}
        {!TIMEZONE_PICKER_GROUPS.some((g) => g.zones.includes(value)) && (
          <optgroup label="Other (saved)">
            <option value={value}>{value}</option>
          </optgroup>
        )}
      </select>
      {showSuggestion && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <span>
            Detected: <code className="font-mono">{browserTz}</code>
          </span>
          <button
            type="button"
            onClick={() => onChange(browserTz)}
            className="text-primary underline"
          >
            Use detected
          </button>
        </p>
      )}
    </div>
  );
}

interface CountryMultiSelectProps {
  value: string[];
  onChange: (next: string[]) => void;
}

/**
 * Phase 4b countries picker. Uses a fixed allowlist from
 * SUPPORTED_TARGETING_COUNTRIES; if we need more later, add them to
 * the shared list. Per-country checkbox keeps the click target large
 * and the picker accessible on mobile.
 */
function CountryMultiSelect({ value, onChange }: CountryMultiSelectProps) {
  function toggle(code: string) {
    if (value.includes(code)) {
      onChange(value.filter((c) => c !== code));
    } else {
      onChange([...value, code]);
    }
  }
  return (
    <div className="border-input grid grid-cols-2 gap-2 rounded-md border p-3 sm:grid-cols-3">
      {SUPPORTED_TARGETING_COUNTRIES.map((c) => (
        <label key={c.code} className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.includes(c.code)}
            onChange={() => toggle(c.code)}
            className="h-4 w-4"
          />
          <span>
            {c.code} <span className="text-muted-foreground">— {c.name}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
