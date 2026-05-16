'use client';

import * as React from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import {
  META_OPTIMIZATION_GOALS,
  META_PLACEMENT_TYPES,
  SUPPORTED_TARGETING_COUNTRIES,
  SettingsFormSchema,
  TIMEZONE_PICKER_GROUPS,
  type SettingsFormInput,
} from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { saveSettingsAction } from './actions';

interface Props {
  initialValues: SettingsFormInput;
  hardCeiling: number;
  aiHardCeiling: number;
  launchHardCeiling: number;
  adDailyHardCeiling: number;
  metaPages: Array<{ pageId: string; pageName: string }>;
  /** ISO timestamp of the last settings save — drives the "Last saved" hint. */
  lastSavedAt: string | null;
  /** Server-rendered card for the Acknowledgments tab. */
  acksPanel: React.ReactNode;
  /** Server-rendered card for the UGC avatar tab. */
  avatarPanel: React.ReactNode;
  /** Server-rendered card for the Account / billing tab. */
  accountPanel: React.ReactNode;
}

type SectionKey = 'kill' | 'scale' | 'caps' | 'summary' | 'launch';
type FieldType =
  | 'number'
  | 'integer'
  | 'currency'
  | 'percent'
  | 'enum-cbo-abo'
  | 'enum-optimization-goal'
  | 'enum-placement-type'
  | 'enum-page'
  | 'multi-country'
  | 'enum-hour'
  | 'boolean'
  | 'timezone';

interface FieldConfig {
  name: keyof SettingsFormInput;
  label: string;
  help: string;
  type: FieldType;
  section: SectionKey;
}

/**
 * Section assignment for every settings field. Tab labels in the UI
 * derive from these section keys.
 *   - kill    → Kill rules
 *   - scale   → Scale tiers
 *   - caps    → Caps (spend / generation caps + polling cadence)
 *   - summary → Daily summary (incl. timezone — the summary fires by it)
 *   - launch  → Launch defaults (Meta-side defaults: page, audience, goal)
 */
const FIELDS: FieldConfig[] = [
  // === caps ===
  {
    name: 'defaultTestCap',
    label: 'Default test cap',
    help: 'USD per ad set when first launched. Variants compete inside this budget.',
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'dailyGenerationVolume',
    label: 'Daily generation volume',
    help: 'How many AI variants to produce per day across all concepts.',
    type: 'integer',
    section: 'caps',
  },
  {
    name: 'platformDailySpendCeiling',
    label: 'Daily spend ceiling',
    help: 'Hard cap on per-day spend across all your ad accounts. USD.',
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'aiGenerationDailyCapUsd',
    label: 'AI generation daily cap',
    help: 'Hard cap on per-day AI generation costs (Gemini, Claude, HeyGen). USD.',
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'dailyLaunchBudgetCapUsd',
    label: 'Daily launch budget cap',
    help: 'Hard cap on per-day total daily budget committed when launching to Meta. USD.',
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'defaultAdDailyBudgetUsd',
    label: 'Default per-ad daily budget',
    help: 'Default daily budget per launched ad. Used unless overridden at launch time. USD.',
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'pollingIntervalMinutes',
    label: 'Polling interval (min)',
    help: 'How often the bot checks each active ad. 15–240 min. Lower = faster reaction, more Meta API calls.',
    type: 'integer',
    section: 'caps',
  },
  // === kill ===
  {
    name: 'killThresholdCpc',
    label: 'CPC kill ceiling',
    help: 'Above this CPC (and CTR low), the bot kills the ad. USD.',
    type: 'currency',
    section: 'kill',
  },
  {
    name: 'killThresholdCtr',
    label: 'CTR kill floor',
    help: 'Below this CTR (and CPC high), the bot kills the ad. Percent.',
    type: 'percent',
    section: 'kill',
  },
  {
    name: 'gracePeriodMinutes',
    label: 'Grace period (minutes)',
    help: 'When CPC is high but CTR is OK, wait this long before re-checking.',
    type: 'integer',
    section: 'kill',
  },
  {
    name: 'hour6CutoffEnabled',
    label: 'Hour 6 cutoff',
    help: 'Kill ads with zero conversions by hour 6, even if CPC/CTR look fine.',
    type: 'boolean',
    section: 'kill',
  },
  {
    name: 'killMaxCpcUsd',
    label: 'Kill: max CPC',
    help: 'Above this CPC (after ≥ $3 spent), the bot proposes killing the ad. USD.',
    type: 'currency',
    section: 'kill',
  },
  {
    name: 'killNoConvSpendUsd',
    label: 'Kill: zero-conversion spend',
    help: 'If the ad has spent this much with no conversions, propose killing. USD.',
    type: 'currency',
    section: 'kill',
  },
  {
    name: 'killMinCtrPct',
    label: 'Kill: min CTR',
    help: 'Below this CTR (after ≥ 1000 impressions), propose killing. Percent.',
    type: 'percent',
    section: 'kill',
  },
  // === scale ===
  {
    name: 'scaleTier1Cap',
    label: 'Scale tier 1 cap',
    help: 'Auto-scale survivors to this daily budget. USD.',
    type: 'currency',
    section: 'scale',
  },
  {
    name: 'scaleTier2Cap',
    label: 'Scale tier 2 cap',
    help: 'Auto-scale tier 1 winners to this daily budget. USD.',
    type: 'currency',
    section: 'scale',
  },
  {
    name: 'manualApprovalThreshold',
    label: 'Manual approval threshold',
    help: 'Above this daily budget, the bot pings you on Telegram before scaling further. USD.',
    type: 'currency',
    section: 'scale',
  },
  {
    name: 'scaleMinRoas',
    label: 'Scale: min implied ROAS',
    help: 'Conversion-count × $20 / spend. Real per-conversion value lands in a later phase.',
    type: 'number',
    section: 'scale',
  },
  {
    name: 'scaleMinSpendUsd',
    label: 'Scale: min spend before considering',
    help: 'Wait until the ad has spent at least this much before considering a scale. USD.',
    type: 'currency',
    section: 'scale',
  },
  {
    name: 'scaleIncrementPct',
    label: 'Scale: increment',
    help: 'How much to raise daily budget per scale event. First-5 cap is +25%, hard ceiling +200%.',
    type: 'percent',
    section: 'scale',
  },
  {
    name: 'scaleMaxDailyBudgetUsd',
    label: 'Scale: max daily budget per ad',
    help: 'Hard ceiling on per-ad daily budget after scaling. USD.',
    type: 'currency',
    section: 'scale',
  },
  // === summary ===
  {
    name: 'dailySummaryEnabled',
    label: 'Daily summary',
    help: 'Receive a daily P&L recap on Telegram. Sent at your local hour below.',
    type: 'boolean',
    section: 'summary',
  },
  {
    name: 'dailySummaryHourLocal',
    label: 'Daily summary hour',
    help: 'Local hour (0–23) to receive the recap. Uses your timezone below.',
    type: 'enum-hour',
    section: 'summary',
  },
  {
    name: 'timezone',
    label: 'Timezone',
    help: 'Daily summaries arrive at midnight in this timezone.',
    type: 'timezone',
    section: 'summary',
  },
  // === launch ===
  {
    name: 'adSetsPerLaunch',
    label: 'Ad sets per launch',
    help: 'How many ad sets to spin up per generation batch. 5 is a sane default.',
    type: 'integer',
    section: 'launch',
  },
  {
    name: 'campaignObjective',
    label: 'Campaign objective',
    help: 'CBO = Meta optimizes budget across ad sets. ABO = each ad set has its own budget.',
    type: 'enum-cbo-abo',
    section: 'launch',
  },
  {
    name: 'defaultOptimizationGoal',
    label: 'Default optimization goal',
    help: 'Meta optimization goal applied to new ad sets at launch.',
    type: 'enum-optimization-goal',
    section: 'launch',
  },
  {
    name: 'defaultPlacementType',
    label: 'Default placement type',
    help: 'Advantage+ lets Meta auto-place; manual restricts placements per ad set.',
    type: 'enum-placement-type',
    section: 'launch',
  },
  {
    name: 'defaultPageId',
    label: 'Default Facebook Page',
    help: 'Page that runs your ads. Pulled from /me/accounts when you connect Meta.',
    type: 'enum-page',
    section: 'launch',
  },
  {
    name: 'defaultTargetingCountries',
    label: 'Default targeting countries',
    help: 'ISO 3166-1 codes. At least one required. Can be overridden per launch.',
    type: 'multi-country',
    section: 'launch',
  },
  {
    name: 'defaultAgeMin',
    label: 'Default min age',
    help: 'Minimum audience age. Meta minimum is 13; we recommend 18.',
    type: 'integer',
    section: 'launch',
  },
  {
    name: 'defaultAgeMax',
    label: 'Default max age',
    help: 'Maximum audience age. Must be ≥ min age.',
    type: 'integer',
    section: 'launch',
  },
];

const TAB_LABELS: Array<{ value: string; label: string; isForm: boolean }> = [
  { value: 'acks', label: 'Acknowledgments', isForm: false },
  { value: 'kill', label: 'Kill rules', isForm: true },
  { value: 'scale', label: 'Scale tiers', isForm: true },
  { value: 'caps', label: 'Caps', isForm: true },
  { value: 'launch', label: 'Launch defaults', isForm: true },
  { value: 'summary', label: 'Daily summary', isForm: true },
  { value: 'avatar', label: 'UGC avatar', isForm: false },
  { value: 'account', label: 'Account', isForm: false },
];

interface ToastState {
  variant: 'success' | 'info' | 'error';
  message: string;
}

export function SettingsForm({
  initialValues,
  hardCeiling,
  aiHardCeiling,
  launchHardCeiling,
  adDailyHardCeiling,
  metaPages,
  lastSavedAt,
  acksPanel,
  avatarPanel,
  accountPanel,
}: Props) {
  const form = useForm<SettingsFormInput>({
    resolver: zodResolver(SettingsFormSchema),
    defaultValues: initialValues,
    mode: 'onBlur',
  });
  const [toast, setToast] = React.useState<ToastState | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [activeTab, setActiveTab] = React.useState<string>('kill');
  const [savedAt, setSavedAt] = React.useState<Date | null>(
    lastSavedAt ? new Date(lastSavedAt) : null,
  );

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
      setSavedAt(new Date());
      // Reset RHF dirty state to the new values so subsequent diffs work.
      form.reset(values);
    });
  });

  const isFormTab = TAB_LABELS.find((t) => t.value === activeTab)?.isForm ?? false;

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
      <TabsList className="bg-bg-elevated h-auto flex-wrap justify-start gap-1 p-1">
        {TAB_LABELS.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="data-[state=active]:bg-bg-active data-[state=active]:text-fg text-fg-muted data-[state=active]:shadow-none"
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Non-form tabs render their server-component panels directly. */}
      <TabsContent value="acks">{acksPanel}</TabsContent>
      <TabsContent value="avatar">{avatarPanel}</TabsContent>
      <TabsContent value="account">{accountPanel}</TabsContent>

      {/* Form tabs share one <form>. We only render the active section's
          fields — the form state lives at the SettingsForm level so
          switching tabs preserves dirty input across them. */}
      <form onSubmit={onSubmit}>
        {(['kill', 'scale', 'caps', 'launch', 'summary'] as SectionKey[]).map((section) => (
          <TabsContent key={section} value={section} className="space-y-6">
            <SectionFields
              section={section}
              form={form}
              metaPages={metaPages}
              hardCeiling={hardCeiling}
              aiHardCeiling={aiHardCeiling}
              launchHardCeiling={launchHardCeiling}
              adDailyHardCeiling={adDailyHardCeiling}
            />
          </TabsContent>
        ))}

        {isFormTab && (
          <div className="bg-bg sticky bottom-0 mt-6 flex flex-wrap items-center justify-between gap-3 border-t py-4">
            <div className="text-fg-muted text-xs">
              {savedAt ? (
                <span>
                  Last saved <RelativeTime date={savedAt} />
                </span>
              ) : (
                <span>Not saved yet</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {toast && (
                <span
                  className={
                    'text-xs ' +
                    (toast.variant === 'error'
                      ? 'text-[color:var(--destructive-color)]'
                      : toast.variant === 'success'
                        ? 'text-success'
                        : 'text-fg-muted')
                  }
                >
                  {toast.message}
                </span>
              )}
              <Button type="submit" disabled={pending}>
                <Save className="h-4 w-4" />
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Tabs>
  );
}

interface SectionFieldsProps {
  section: SectionKey;
  form: ReturnType<typeof useForm<SettingsFormInput>>;
  metaPages: Array<{ pageId: string; pageName: string }>;
  hardCeiling: number;
  aiHardCeiling: number;
  launchHardCeiling: number;
  adDailyHardCeiling: number;
}

function SectionFields({
  section,
  form,
  metaPages,
  hardCeiling,
  aiHardCeiling,
  launchHardCeiling,
  adDailyHardCeiling,
}: SectionFieldsProps) {
  const fields = FIELDS.filter((f) => f.section === section);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {fields.map((field) => {
        const error = form.formState.errors[field.name] as FieldError | undefined;
        return (
          <FieldRow
            key={field.name}
            field={field}
            form={form}
            metaPages={metaPages}
            error={error}
            hardCeiling={hardCeiling}
            aiHardCeiling={aiHardCeiling}
            launchHardCeiling={launchHardCeiling}
            adDailyHardCeiling={adDailyHardCeiling}
          />
        );
      })}
    </div>
  );
}

interface FieldRowProps {
  field: FieldConfig;
  form: ReturnType<typeof useForm<SettingsFormInput>>;
  metaPages: Array<{ pageId: string; pageName: string }>;
  error?: FieldError;
  hardCeiling: number;
  aiHardCeiling: number;
  launchHardCeiling: number;
  adDailyHardCeiling: number;
}

function FieldRow({
  field,
  form,
  metaPages,
  error,
  hardCeiling,
  aiHardCeiling,
  launchHardCeiling,
  adDailyHardCeiling,
}: FieldRowProps) {
  // Multi-country picker spans the full width on every viewport — its
  // grid of checkboxes is wider than one column allows.
  const fullWidth = field.type === 'multi-country';

  return (
    <div className={`space-y-1.5 ${fullWidth ? 'md:col-span-2' : ''}`}>
      <Label htmlFor={field.name}>{field.label}</Label>
      <p className="text-fg-muted text-xs">{field.help}</p>

      {field.type === 'enum-cbo-abo' && (
        <NativeSelect id={field.name} {...form.register(field.name)}>
          <option value="CBO">CBO — campaign-budget optimization</option>
          <option value="ABO">ABO — ad-set budget optimization</option>
        </NativeSelect>
      )}

      {field.type === 'enum-optimization-goal' && (
        <NativeSelect id={field.name} {...form.register(field.name)}>
          {META_OPTIMIZATION_GOALS.map((goal) => (
            <option key={goal} value={goal}>
              {goal}
            </option>
          ))}
        </NativeSelect>
      )}

      {field.type === 'enum-placement-type' && (
        <NativeSelect id={field.name} {...form.register(field.name)}>
          {META_PLACEMENT_TYPES.map((p) => (
            <option key={p} value={p}>
              {p === 'advantage_plus' ? 'Advantage+ (auto placements)' : 'Manual placements'}
            </option>
          ))}
        </NativeSelect>
      )}

      {field.type === 'enum-page' &&
        (metaPages.length === 0 ? (
          <p className="text-fg-muted text-xs">
            No Facebook Pages cached yet. Reconnect Meta or run a live launch — pages refresh on
            demand.
          </p>
        ) : (
          <NativeSelect id={field.name} {...form.register(field.name)}>
            <option value="">— Select a page —</option>
            {metaPages.map((p) => (
              <option key={p.pageId} value={p.pageId}>
                {p.pageName} ({p.pageId})
              </option>
            ))}
          </NativeSelect>
        ))}

      {field.type === 'enum-hour' && (
        <NativeSelect id={field.name} {...form.register(field.name)}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}:00
            </option>
          ))}
        </NativeSelect>
      )}

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
        <div className="flex items-center gap-3 pt-1">
          <Switch
            id={field.name}
            checked={form.watch(field.name) as boolean}
            onCheckedChange={(checked) =>
              form.setValue(field.name, checked as never, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          />
          <span className="text-fg-muted text-sm">
            {(form.watch(field.name) as boolean) ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      )}

      {(field.type === 'number' ||
        field.type === 'integer' ||
        field.type === 'currency' ||
        field.type === 'percent') && (
        <div className="relative">
          {field.type === 'currency' && (
            <span className="text-fg-muted absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm">
              $
            </span>
          )}
          <Input
            id={field.name}
            type="number"
            step={field.type === 'currency' ? '0.01' : field.type === 'percent' ? '0.1' : '1'}
            inputMode="decimal"
            {...form.register(field.name)}
            className={`font-mono ${field.type === 'currency' ? 'pl-7' : ''}`}
          />
          {field.type === 'percent' && (
            <span className="text-fg-muted absolute right-3 top-1/2 -translate-y-1/2 font-mono text-sm">
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
        <p className="text-fg-subtle text-xs">
          Platform hard ceiling: <span className="font-mono">${hardCeiling}</span>.
        </p>
      )}
      {field.name === 'aiGenerationDailyCapUsd' && (
        <p className="text-fg-subtle text-xs">
          Platform hard ceiling: <span className="font-mono">${aiHardCeiling}</span>.
        </p>
      )}
      {field.name === 'dailyLaunchBudgetCapUsd' && (
        <p className="text-fg-subtle text-xs">
          Platform hard ceiling: <span className="font-mono">${launchHardCeiling}</span>.
        </p>
      )}
      {field.name === 'defaultAdDailyBudgetUsd' && (
        <p className="text-fg-subtle text-xs">
          Per-ad hard ceiling: <span className="font-mono">${adDailyHardCeiling}</span>.
        </p>
      )}

      {error && <p className="text-xs text-[color:var(--destructive-color)]">{error.message}</p>}
    </div>
  );
}

const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function NativeSelect({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={`border-input bg-bg-elevated text-fg focus:ring-ring h-9 w-full rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-offset-1 ${className ?? ''}`}
      {...props}
    >
      {children}
    </select>
  );
});

interface TimezoneFieldProps {
  name: string;
  value: string;
  onChange: (tz: string) => void;
}

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
      <NativeSelect id={name} value={value} onChange={(e) => onChange(e.target.value)}>
        {TIMEZONE_PICKER_GROUPS.map((group) => (
          <optgroup key={group.region} label={group.region}>
            {group.zones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </optgroup>
        ))}
        {!TIMEZONE_PICKER_GROUPS.some((g) => g.zones.includes(value)) && (
          <optgroup label="Other (saved)">
            <option value={value}>{value}</option>
          </optgroup>
        )}
      </NativeSelect>
      {showSuggestion && (
        <p className="text-fg-muted flex items-center gap-2 text-xs">
          <span>
            Detected: <code className="font-mono">{browserTz}</code>
          </span>
          <button
            type="button"
            onClick={() => onChange(browserTz)}
            className="hover:text-fg underline transition-colors"
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
          <Checkbox checked={value.includes(c.code)} onCheckedChange={() => toggle(c.code)} />
          <span>
            <span className="font-mono">{c.code}</span>{' '}
            <span className="text-fg-muted">— {c.name}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * "Saved 5 minutes ago" — re-computed every 30s so the timestamp stays
 * fresh while the user is on the page. No external dep; keep it tiny.
 */
function RelativeTime({ date }: { date: Date }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const diff = now - date.getTime();
  if (diff < 60_000) return <>just now</>;
  if (diff < 3_600_000) return <>{Math.floor(diff / 60_000)} min ago</>;
  if (diff < 86_400_000) return <>{Math.floor(diff / 3_600_000)} h ago</>;
  return <>{date.toISOString().slice(0, 10)}</>;
}
