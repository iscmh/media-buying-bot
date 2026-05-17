'use client';

import * as React from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { HelpCircle, Save } from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
  /** Plain-English label shown above the input. */
  label: string;
  /** One-liner under the label — short, factual. */
  help: string;
  /** "Why this matters" copy for the ? tooltip — 1-2 media-buyer
   *  sentences. Hover/focus on the icon to reveal. */
  tooltip?: string;
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
    label: 'Test budget per ad set',
    help: 'USD spent per new ad set before kill/scale rules kick in.',
    tooltip:
      'New variants compete inside this budget. Set it big enough to give every variant ~100 impressions so CTR is meaningful, but small enough that losers stop bleeding fast.',
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'dailyGenerationVolume',
    label: 'Variants generated per day',
    help: 'Total AI variants across all concepts.',
    tooltip:
      'Caps your daily AI generation throughput. Most operators run 20-40 — high enough to keep new creative in market, low enough to actually review the outputs.',
    type: 'integer',
    section: 'caps',
  },
  {
    name: 'platformDailySpendCeiling',
    label: 'Maximum daily Meta spend',
    help: 'Hard cap across all your ad accounts. USD.',
    tooltip:
      'The big-red-button. Even if every kill rule fails, total Meta spend in any one day cannot exceed this. Set it to your nightmare-scenario tolerance.',
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'aiGenerationDailyCapUsd',
    label: 'Maximum daily AI spend',
    help: 'Per-day cap on Gemini + Claude + HeyGen API costs. USD.',
    tooltip:
      'Independent of Meta spend. Generation jobs that would push you over this in a calendar day are blocked server-side. Burns are usually pennies; this stops a runaway loop, not your normal usage.',
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'dailyLaunchBudgetCapUsd',
    label: 'Maximum daily new-launch budget',
    help: 'Hard cap on per-day total daily budget committed via the bot. USD.',
    tooltip:
      "How much new daily-budget the bot is allowed to commit to Meta in any one day. Includes test caps + first-scale bumps. Doesn't count already-live ads.",
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'defaultAdDailyBudgetUsd',
    label: 'Default budget per ad',
    help: 'Per-ad daily budget at launch. USD.',
    tooltip:
      "What every new ad starts at. The launch dialog lets you override per-launch, but most of the time you'll just want this default.",
    type: 'currency',
    section: 'caps',
  },
  {
    name: 'pollingIntervalMinutes',
    label: 'How often to check ads',
    help: 'Polling cadence in minutes (15–240).',
    tooltip:
      'How often the bot pulls performance numbers from Meta for each active ad. Lower = faster kill/scale decisions but more Meta API calls (rate-limit risk). 30 min is a sane default.',
    type: 'integer',
    section: 'caps',
  },
  // === kill ===
  {
    name: 'killThresholdCpc',
    label: 'Maximum cost per click (kill above this)',
    help: 'USD per click. Triggers when CTR is also low.',
    tooltip:
      'Two-signal kill: only fires when CPC is above this AND CTR is below the floor. Catches expensive-but-clickbaity ads that pass either rule alone.',
    type: 'currency',
    section: 'kill',
  },
  {
    name: 'killThresholdCtr',
    label: 'Minimum click-through rate (kill below this)',
    help: 'Percent. Triggers when CPC is also high.',
    tooltip:
      'The other half of the two-signal kill. Set this to your floor for "this creative is dead" — typically 1-2% for cold traffic, higher for warm.',
    type: 'percent',
    section: 'kill',
  },
  {
    name: 'gracePeriodMinutes',
    label: 'Grace period before re-checking',
    help: 'Minutes to wait when CPC is high but CTR is OK.',
    tooltip:
      'When an ad is borderline (CPC high, CTR fine), the bot waits this long before deciding to kill. Stops you from killing ads in their first noisy 30 minutes.',
    type: 'integer',
    section: 'kill',
  },
  {
    name: 'hour6CutoffEnabled',
    label: 'Kill if no conversions by hour 6',
    help: 'Even if CPC/CTR look fine.',
    tooltip:
      'A "no conversions in 6 hours" ad is almost always dead even if metrics look OK. This catches the worst-offender pattern: solid CTR, zero buyers. Highly recommended on.',
    type: 'boolean',
    section: 'kill',
  },
  {
    name: 'killMaxCpcUsd',
    label: 'Kill if CPC exceeds (after $3 spent)',
    help: 'USD per click. Single-signal kill once warm.',
    tooltip:
      'Once an ad has spent $3+ on clicks, this single-signal CPC threshold fires kill recommendations to Telegram. Faster than the two-signal rule above; use it as a hard upper bound.',
    type: 'currency',
    section: 'kill',
  },
  {
    name: 'killNoConvSpendUsd',
    label: 'Kill at zero-conversion spend',
    help: 'USD spent with zero conversions before proposing kill.',
    tooltip:
      'If an ad spent this much with zero conversions, the bot proposes killing it. Lower = more aggressive (less test budget wasted, but more false kills on conversion-lag offers).',
    type: 'currency',
    section: 'kill',
  },
  {
    name: 'killMinCtrPct',
    label: 'Kill if CTR drops below (after 1k impressions)',
    help: 'Percent. Single-signal CTR kill once warm.',
    tooltip:
      'Once an ad has 1000+ impressions, this single-signal CTR floor fires kill recommendations. Different from the two-signal rule above — this catches low-CTR ads that have a workable CPC.',
    type: 'percent',
    section: 'kill',
  },
  // === scale ===
  {
    name: 'scaleTier1Cap',
    label: 'Tier 1 daily budget cap (first scale)',
    help: 'First scale step — auto-applied to survivors. USD.',
    tooltip:
      'When a test-budget ad survives kill rules and clears the min-ROAS bar, the bot scales it to this daily budget. Tier 1 is "I trust this, but not too much yet".',
    type: 'currency',
    section: 'scale',
  },
  {
    name: 'scaleTier2Cap',
    label: 'Tier 2 daily budget cap (second scale)',
    help: 'Second scale step — for ads that survived tier 1. USD.',
    tooltip:
      'After an ad performs well at Tier 1, it gets promoted to Tier 2. This is the "I\'m confident — push it" cap. Past Tier 2, the bot asks you on Telegram before going further.',
    type: 'currency',
    section: 'scale',
  },
  {
    name: 'manualApprovalThreshold',
    label: 'Ask before scaling beyond',
    help: 'Above this daily budget, ping on Telegram first. USD.',
    tooltip:
      'Your "before you scale this further, check with me" line. The bot will send a Telegram inline-keyboard prompt instead of auto-scaling past this.',
    type: 'currency',
    section: 'scale',
  },
  {
    name: 'scaleMinRoas',
    label: 'Minimum ROAS to consider scaling',
    help: 'Implied ROAS = conversions × $20 / spend.',
    tooltip:
      'The bar an ad has to clear before the bot will propose scaling it. Until per-conversion value tracking lands, this uses a $20-per-conv heuristic — tune up if your AOV is higher.',
    type: 'number',
    section: 'scale',
  },
  {
    name: 'scaleMinSpendUsd',
    label: 'Minimum spend before considering scale',
    help: 'USD. Wait until the ad has spent at least this much.',
    tooltip:
      'Stops the bot from scaling on noisy early numbers (one lucky conversion at $5 spend ≠ winner). Match this to roughly 2-3× your test cap.',
    type: 'currency',
    section: 'scale',
  },
  {
    name: 'scaleIncrementPct',
    label: 'Scale increment per event',
    help: 'Percent. First 5 scales auto-capped at +25%.',
    tooltip:
      'How much each scale event raises the daily budget. Meta penalizes aggressive scaling (sub-optimal delivery for ~48h); 25-50% per event is typical, +200% is the hard ceiling.',
    type: 'percent',
    section: 'scale',
  },
  {
    name: 'scaleMaxDailyBudgetUsd',
    label: 'Maximum per-ad daily budget',
    help: 'Ceiling after all scaling. USD.',
    tooltip:
      "No single ad goes above this regardless of how well it's performing. Protects you from one runaway winner consuming the whole platform cap.",
    type: 'currency',
    section: 'scale',
  },
  // === summary ===
  {
    name: 'dailySummaryEnabled',
    label: 'Daily summary on Telegram',
    help: 'P&L recap sent to your Telegram chat once per day.',
    tooltip:
      "A morning briefing: yesterday's spend, conversions, ROAS, kills, scales. Skip it if you'd rather just check the dashboard.",
    type: 'boolean',
    section: 'summary',
  },
  {
    name: 'dailySummaryHourLocal',
    label: 'Send time (local hour)',
    help: 'Hour 0–23 in your timezone.',
    tooltip:
      'When the daily summary fires, using the timezone below. Most operators pick 8-9am — right before you sit down to look at ad performance.',
    type: 'enum-hour',
    section: 'summary',
  },
  {
    name: 'timezone',
    label: 'Your timezone',
    help: 'IANA zone — used for summaries + daily caps.',
    tooltip:
      'Drives both when the daily summary fires AND when your daily spend caps reset (midnight in this zone). The detected zone from your browser is usually right.',
    type: 'timezone',
    section: 'summary',
  },
  // === launch ===
  {
    name: 'adSetsPerLaunch',
    label: 'Ad sets per launch batch',
    help: 'How many ad sets to spin up when you launch a generation.',
    tooltip:
      "Each ad set runs a subset of your variants. 5 is the sweet spot — enough variance for Meta's algo to find a winner, not so many that any one gets starved of spend.",
    type: 'integer',
    section: 'launch',
  },
  {
    name: 'campaignObjective',
    label: 'Campaign budget structure',
    help: 'CBO lets Meta allocate; ABO gives each ad set its own budget.',
    tooltip:
      'CBO (campaign budget optimization) hands Meta the total daily budget and lets it shift spend toward the best ad set. ABO (ad set budget) gives each its own — tighter control, less algo learning.',
    type: 'enum-cbo-abo',
    section: 'launch',
  },
  {
    name: 'defaultOptimizationGoal',
    label: 'Optimization goal',
    help: 'What Meta optimizes ad delivery for.',
    tooltip:
      'Meta picks who to show your ad to based on this. CONVERSIONS = best for offers (slower learning, higher quality). LINK_CLICKS = best for traffic (faster, noisier).',
    type: 'enum-optimization-goal',
    section: 'launch',
  },
  {
    name: 'defaultPlacementType',
    label: 'Placement type',
    help: 'Advantage+ = auto. Manual = you pick.',
    tooltip:
      'Advantage+ lets Meta choose placements (FB feed, IG feed, Stories, Reels, etc.) for best results — usually the right call. Manual restricts to a specific placement; use sparingly.',
    type: 'enum-placement-type',
    section: 'launch',
  },
  {
    name: 'defaultPageId',
    label: 'Facebook Page',
    help: 'The Page your ads run from.',
    tooltip:
      'Required by Meta — every ad has a Page identity. Refresh the list by reconnecting Meta if your Page is missing.',
    type: 'enum-page',
    section: 'launch',
  },
  {
    name: 'defaultTargetingCountries',
    label: 'Target countries',
    help: 'At least one. Override per launch.',
    tooltip:
      'Default geo for new ads. Most operators run US-only at the test stage and expand to T1 countries once a winner emerges.',
    type: 'multi-country',
    section: 'launch',
  },
  {
    name: 'defaultAgeMin',
    label: 'Minimum audience age',
    help: 'Meta minimum is 13; we recommend 18+.',
    tooltip:
      "Match your offer's legal age requirement at minimum. For MMO / biz-opp / finance verticals, 25+ usually pays better than 18-24.",
    type: 'integer',
    section: 'launch',
  },
  {
    name: 'defaultAgeMax',
    label: 'Maximum audience age',
    help: 'Must be ≥ minimum.',
    tooltip:
      '65 = "no upper bound" for Meta (it caps the visible range). Lower if your offer skews young.',
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
    <TooltipProvider delayDuration={150}>
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
    </TooltipProvider>
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
      <div className="flex items-center gap-1.5">
        <Label htmlFor={field.name}>{field.label}</Label>
        {field.tooltip && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`What does ${field.label} mean?`}
                className="text-fg-subtle hover:text-fg-muted inline-flex items-center transition-colors"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              {field.tooltip}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
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
