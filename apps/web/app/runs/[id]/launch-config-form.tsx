'use client';

/**
 * Polish-28.4.1 Commit 99: full Meta-Ads-Manager-parity launch form.
 *
 * Sectioned config matching Meta's own ad-set creation flow. Each
 * section is a titled block with progressive disclosure — the bid
 * amount input only surfaces when bid strategy != LOWEST_COST; the
 * pixel + conversion-event inputs only surface when the objective is
 * SALES or LEADS; manual placement checkboxes only surface when
 * placement mode = manual.
 *
 * All state is a single LaunchConfig object owned by the parent
 * (job-review-client.tsx). Parent renders the form inside the launch
 * dialog and threads every field into launchApprovedAction on submit.
 * See Polish-28.4.0 Commit 98 for the backend un-hardcoding that
 * accepts this config end-to-end.
 */

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type CampaignObjective =
  | 'OUTCOME_SALES'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_AWARENESS';

export type SpecialAdCategory = 'CREDIT' | 'EMPLOYMENT' | 'HOUSING' | 'ISSUES_ELECTIONS_POLITICS';

export type BidStrategy = 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'BID_CAP';

export type OptimizationGoal =
  | 'LINK_CLICKS'
  | 'LANDING_PAGE_VIEWS'
  | 'OFFSITE_CONVERSIONS'
  | 'VALUE'
  | 'LEAD_GENERATION'
  | 'QUALITY_LEAD'
  | 'POST_ENGAGEMENT'
  | 'PAGE_LIKES'
  | 'THRUPLAY'
  | 'VIDEO_VIEWS'
  | 'REACH'
  | 'IMPRESSIONS';

export type BillingEvent = 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY' | 'POST_ENGAGEMENT';

export type ConversionLocation = 'WEBSITE' | 'MESSENGER' | 'INSTAGRAM_DIRECT' | 'WHATSAPP';

export type PublisherPlatform = 'facebook' | 'instagram' | 'audience_network' | 'messenger';

export type CallToActionType =
  | 'LEARN_MORE'
  | 'SHOP_NOW'
  | 'SIGN_UP'
  | 'SUBSCRIBE'
  | 'GET_OFFER'
  | 'DOWNLOAD'
  | 'GET_QUOTE'
  | 'CONTACT_US'
  | 'APPLY_NOW'
  | 'BOOK_TRAVEL'
  | 'WATCH_MORE'
  | 'LISTEN_NOW'
  | 'INSTALL_APP'
  | 'USE_APP'
  | 'PLAY_GAME'
  | 'ORDER_NOW';

export type PlacementMode = 'advantage_plus' | 'manual';

/**
 * The single source of truth for the form. Parent owns this object,
 * form calls onChange(patch) with a partial to merge.
 */
export interface LaunchConfig {
  // Campaign section
  campaignName: string;
  campaignObjective: CampaignObjective;
  specialAdCategories: SpecialAdCategory[];
  budgetOptimizationEnabled: boolean; // CBO
  campaignDailyBudgetUsd: number;

  // Conversion section (surfaces per objective)
  conversionLocation: ConversionLocation;
  pixelId: string;
  customEventType: string;

  // Ad set / budget
  perAdDailyBudgetUsd: number;
  optimizationGoal: OptimizationGoal;
  bidStrategy: BidStrategy;
  bidAmountUsd: number;
  billingEvent: BillingEvent;

  // Targeting
  pageId: string;
  offerUrl: string;
  targetingCountries: string[];
  ageMin: number;
  ageMax: number;
  advantageAudienceEnabled: boolean;
  locales: number[];
  includedCustomAudienceIds: string[];
  excludedCustomAudienceIds: string[];

  // Placements
  placementMode: PlacementMode;
  publisherPlatforms: PublisherPlatform[];
  facebookPositions: string[];
  instagramPositions: string[];
  audienceNetworkPositions: string[];
  messengerPositions: string[];

  // Schedule
  startTime: string; // ISO or '' for now
  endTime: string; // ISO or '' for never

  // Creative
  callToActionType: CallToActionType;
}

export interface LaunchConfigFormProps {
  value: LaunchConfig;
  onChange: (patch: Partial<LaunchConfig>) => void;
  // Page picker source-of-truth lives above the form.
  pages: Array<{ pageId: string; pageName: string }>;
  onRefreshPages: () => void;
  pagesRefreshing: boolean;
  pagesError: string | null;
  // Info for display + validation
  approvedCount: number;
}

// -----------------------------------------------------------------------------
// Field labels (Meta's official copy where possible)
// -----------------------------------------------------------------------------

const OBJECTIVE_OPTIONS: Array<{
  value: CampaignObjective;
  label: string;
  description: string;
  compatibleGoals: OptimizationGoal[];
}> = [
  {
    value: 'OUTCOME_SALES',
    label: 'Sales',
    description: 'Find people likely to buy your product or service.',
    compatibleGoals: ['OFFSITE_CONVERSIONS', 'VALUE', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS'],
  },
  {
    value: 'OUTCOME_LEADS',
    label: 'Leads',
    description: 'Collect leads for your business.',
    compatibleGoals: ['LEAD_GENERATION', 'QUALITY_LEAD', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS'],
  },
  {
    value: 'OUTCOME_ENGAGEMENT',
    label: 'Engagement',
    description: 'Get more messages, video views, post engagement, page likes, or event responses.',
    compatibleGoals: ['POST_ENGAGEMENT', 'THRUPLAY', 'VIDEO_VIEWS', 'PAGE_LIKES', 'LINK_CLICKS'],
  },
  {
    value: 'OUTCOME_TRAFFIC',
    label: 'Traffic',
    description: 'Send people to a destination like your website, app, or Messenger conversation.',
    compatibleGoals: ['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'POST_ENGAGEMENT'],
  },
  {
    value: 'OUTCOME_AWARENESS',
    label: 'Awareness',
    description: 'Show your ads to people most likely to remember them.',
    compatibleGoals: ['REACH', 'IMPRESSIONS'],
  },
];

const SPECIAL_AD_CATEGORY_OPTIONS: Array<{ value: SpecialAdCategory; label: string }> = [
  { value: 'CREDIT', label: 'Credit' },
  { value: 'EMPLOYMENT', label: 'Employment' },
  { value: 'HOUSING', label: 'Housing' },
  { value: 'ISSUES_ELECTIONS_POLITICS', label: 'Social issues, elections or politics' },
];

const BID_STRATEGY_OPTIONS: Array<{ value: BidStrategy; label: string; description: string }> = [
  {
    value: 'LOWEST_COST_WITHOUT_CAP',
    label: 'Highest volume',
    description: 'Get the most results for your budget. Meta automatically adjusts your bid.',
  },
  {
    value: 'COST_CAP',
    label: 'Cost cap',
    description: 'Set a target average cost per result. Individual costs may vary.',
  },
  {
    value: 'BID_CAP',
    label: 'Bid cap',
    description: 'Set the maximum amount to bid in each auction. May not spend full budget.',
  },
];

const CONVERSION_LOCATION_OPTIONS: Array<{
  value: ConversionLocation;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}> = [
  { value: 'WEBSITE', label: 'Website' },
  {
    value: 'MESSENGER',
    label: 'Messenger',
    disabled: true,
    disabledReason: 'Coming soon — needs a different creative shape.',
  },
  {
    value: 'INSTAGRAM_DIRECT',
    label: 'Instagram DM',
    disabled: true,
    disabledReason: 'Coming soon.',
  },
  {
    value: 'WHATSAPP',
    label: 'WhatsApp',
    disabled: true,
    disabledReason: 'Coming soon.',
  },
];

const CTA_OPTIONS: CallToActionType[] = [
  'LEARN_MORE',
  'SHOP_NOW',
  'SIGN_UP',
  'SUBSCRIBE',
  'GET_OFFER',
  'DOWNLOAD',
  'GET_QUOTE',
  'CONTACT_US',
  'APPLY_NOW',
  'BOOK_TRAVEL',
  'WATCH_MORE',
  'LISTEN_NOW',
  'INSTALL_APP',
  'USE_APP',
  'PLAY_GAME',
  'ORDER_NOW',
];

const PUBLISHER_PLATFORM_OPTIONS: Array<{ value: PublisherPlatform; label: string }> = [
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'audience_network', label: 'Audience Network' },
  { value: 'messenger', label: 'Messenger' },
];

const FB_POSITIONS = ['feed', 'right_hand_column', 'video_feeds', 'story', 'marketplace', 'reels'];
const IG_POSITIONS = ['stream', 'story', 'reels', 'explore', 'explore_home'];
const AN_POSITIONS = ['classic', 'rewarded_video'];
const MSGR_POSITIONS = ['story'];

/**
 * Returns the default sensible LaunchConfig, seeded from the operator's
 * user_settings defaults + concept metadata. Parent uses this once to
 * initialize its state.
 */
export function defaultLaunchConfig(seed: {
  defaultOfferUrl: string;
  defaultPageId: string;
  defaultCountries: string[];
  defaultAgeMin: number;
  defaultAgeMax: number;
  defaultPerAdBudgetUsd: number;
}): LaunchConfig {
  return {
    campaignName: '',
    campaignObjective: 'OUTCOME_TRAFFIC',
    specialAdCategories: [],
    budgetOptimizationEnabled: false,
    campaignDailyBudgetUsd: seed.defaultPerAdBudgetUsd,
    conversionLocation: 'WEBSITE',
    pixelId: '',
    customEventType: '',
    perAdDailyBudgetUsd: seed.defaultPerAdBudgetUsd,
    optimizationGoal: 'LINK_CLICKS',
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    bidAmountUsd: 0,
    billingEvent: 'IMPRESSIONS',
    pageId: seed.defaultPageId,
    offerUrl: seed.defaultOfferUrl,
    targetingCountries: seed.defaultCountries,
    ageMin: seed.defaultAgeMin,
    ageMax: seed.defaultAgeMax,
    advantageAudienceEnabled: true,
    locales: [],
    includedCustomAudienceIds: [],
    excludedCustomAudienceIds: [],
    placementMode: 'advantage_plus',
    publisherPlatforms: ['facebook', 'instagram'],
    facebookPositions: ['feed'],
    instagramPositions: ['stream'],
    audienceNetworkPositions: [],
    messengerPositions: [],
    startTime: '',
    endTime: '',
    callToActionType: 'LEARN_MORE',
  };
}

/**
 * Validate the config for launch readiness. Returns a list of blocking
 * issues; parent's Launch button is disabled while non-empty.
 */
export function validateLaunchConfig(cfg: LaunchConfig): string[] {
  const issues: string[] = [];
  if (!cfg.pageId) issues.push('Pick a Facebook Page.');
  if (!cfg.offerUrl.startsWith('http://') && !cfg.offerUrl.startsWith('https://')) {
    issues.push('Offer URL must start with http:// or https://.');
  }
  if (cfg.targetingCountries.length === 0) issues.push('Pick at least one country.');
  if (cfg.budgetOptimizationEnabled && cfg.campaignDailyBudgetUsd <= 0) {
    issues.push('CBO enabled — enter a campaign daily budget.');
  }
  if (!cfg.budgetOptimizationEnabled && cfg.perAdDailyBudgetUsd <= 0) {
    issues.push('Enter a per-ad daily budget.');
  }
  if (cfg.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP' && cfg.bidAmountUsd <= 0) {
    issues.push(
      `${cfg.bidStrategy === 'COST_CAP' ? 'Cost cap' : 'Bid cap'} needs a positive amount.`,
    );
  }
  if (
    (cfg.campaignObjective === 'OUTCOME_SALES' || cfg.campaignObjective === 'OUTCOME_LEADS') &&
    cfg.conversionLocation === 'WEBSITE' &&
    (!cfg.pixelId || !cfg.customEventType)
  ) {
    issues.push('Sales / Leads over Website needs a Pixel ID and conversion event.');
  }
  if (cfg.placementMode === 'manual' && cfg.publisherPlatforms.length === 0) {
    issues.push('Manual placements — pick at least one platform.');
  }
  return issues;
}

// -----------------------------------------------------------------------------
// The form
// -----------------------------------------------------------------------------

export function LaunchConfigForm({
  value,
  onChange,
  pages,
  onRefreshPages,
  pagesRefreshing,
  pagesError,
  approvedCount,
}: LaunchConfigFormProps): React.ReactElement {
  const objective = OBJECTIVE_OPTIONS.find((o) => o.value === value.campaignObjective)!;

  const set = React.useCallback(
    <K extends keyof LaunchConfig>(k: K, v: LaunchConfig[K]) => onChange({ [k]: v } as never),
    [onChange],
  );

  const toggleInArray = React.useCallback(
    <T extends string>(arr: T[], item: T): T[] =>
      arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item],
    [],
  );

  return (
    <div className="space-y-6">
      {/* -----------------------------------------------------------------
          Section: Campaign
          ----------------------------------------------------------------- */}
      <Section title="Campaign">
        <Field label="Objective" hint="What you want people to do when they see your ads.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {OBJECTIVE_OPTIONS.map((o) => (
              <ChipButton
                key={o.value}
                selected={value.campaignObjective === o.value}
                onClick={() => {
                  set('campaignObjective', o.value);
                  // Auto-pick a sensible optimization goal for the new objective.
                  if (!o.compatibleGoals.includes(value.optimizationGoal)) {
                    set('optimizationGoal', o.compatibleGoals[0]!);
                  }
                }}
                label={o.label}
              />
            ))}
          </div>
          <p className="text-fg-muted mt-1.5 text-xs leading-relaxed">{objective.description}</p>
        </Field>

        <Field label="Campaign name" hint="Auto-generated from the job if left blank.">
          <Input
            type="text"
            value={value.campaignName}
            onChange={(e) => set('campaignName', e.target.value)}
            placeholder={`Job ${approvedCount} variants — auto`}
          />
        </Field>

        <Field
          label="Special ad category"
          hint="Required for credit, employment, housing, or political ads."
        >
          <div className="flex flex-wrap gap-2">
            <ChipButton
              selected={value.specialAdCategories.length === 0}
              onClick={() => set('specialAdCategories', [])}
              label="None"
            />
            {SPECIAL_AD_CATEGORY_OPTIONS.map((c) => (
              <ChipButton
                key={c.value}
                selected={value.specialAdCategories.includes(c.value)}
                onClick={() =>
                  set('specialAdCategories', toggleInArray(value.specialAdCategories, c.value))
                }
                label={c.label}
              />
            ))}
          </div>
        </Field>

        <Field
          label="Budget control"
          hint="Split one campaign budget across ad groups (CBO), or set one per ad group (ABO)."
        >
          <div className="flex gap-2">
            <ChipButton
              selected={value.budgetOptimizationEnabled}
              onClick={() => set('budgetOptimizationEnabled', true)}
              label="CBO (campaign budget)"
            />
            <ChipButton
              selected={!value.budgetOptimizationEnabled}
              onClick={() => set('budgetOptimizationEnabled', false)}
              label="ABO (per-ad budget)"
            />
          </div>
        </Field>

        {value.budgetOptimizationEnabled && (
          <Field label="Campaign daily budget" hint="Meta redistributes this across ad sets.">
            <DollarInput
              value={value.campaignDailyBudgetUsd}
              onChange={(v) => set('campaignDailyBudgetUsd', v)}
            />
          </Field>
        )}
      </Section>

      {/* -----------------------------------------------------------------
          Section: Conversion (only for Sales/Leads + Website)
          ----------------------------------------------------------------- */}
      {(value.campaignObjective === 'OUTCOME_SALES' ||
        value.campaignObjective === 'OUTCOME_LEADS') && (
        <Section title="Conversion">
          <Field label="Conversion location">
            <div className="flex flex-wrap gap-2">
              {CONVERSION_LOCATION_OPTIONS.map((c) => (
                <ChipButton
                  key={c.value}
                  selected={value.conversionLocation === c.value}
                  onClick={() => !c.disabled && set('conversionLocation', c.value)}
                  label={c.label}
                  disabled={c.disabled}
                  title={c.disabledReason}
                />
              ))}
            </div>
          </Field>

          {value.conversionLocation === 'WEBSITE' && (
            <>
              <Field
                label="Pixel ID"
                hint="Find it in Meta Events Manager → Data sources. Numeric ID."
              >
                <Input
                  type="text"
                  value={value.pixelId}
                  onChange={(e) => set('pixelId', e.target.value)}
                  placeholder="123456789012345"
                />
              </Field>
              <Field
                label="Conversion event"
                hint="The action you want people to take. e.g. PURCHASE, LEAD, INITIATE_CHECKOUT, VIEW_CONTENT."
              >
                <Input
                  type="text"
                  value={value.customEventType}
                  onChange={(e) => set('customEventType', e.target.value.toUpperCase())}
                  placeholder="PURCHASE"
                />
              </Field>
            </>
          )}
        </Section>
      )}

      {/* -----------------------------------------------------------------
          Section: Ad set — budget + bid + optimization goal
          ----------------------------------------------------------------- */}
      <Section title="Ad set">
        {!value.budgetOptimizationEnabled && (
          <Field label="Per-ad daily budget">
            <DollarInput
              value={value.perAdDailyBudgetUsd}
              onChange={(v) => set('perAdDailyBudgetUsd', v)}
            />
          </Field>
        )}

        <Field
          label="Optimization goal"
          hint="What Meta optimizes ad delivery for. Options change with the campaign objective above."
        >
          <select
            value={value.optimizationGoal}
            onChange={(e) => set('optimizationGoal', e.target.value as OptimizationGoal)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
          >
            {objective.compatibleGoals.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Bid strategy" hint="How Meta spends your budget.">
          <div className="space-y-2">
            {BID_STRATEGY_OPTIONS.map((b) => (
              <button
                key={b.value}
                type="button"
                onClick={() => set('bidStrategy', b.value)}
                className={cn(
                  'w-full rounded-md border p-3 text-left transition-colors',
                  value.bidStrategy === b.value
                    ? 'border-fg bg-fg/5'
                    : 'border-border bg-bg-surface hover:border-fg/50',
                )}
              >
                <div className="text-fg text-sm font-medium">{b.label}</div>
                <div className="text-fg-muted mt-0.5 text-xs">{b.description}</div>
              </button>
            ))}
          </div>
        </Field>

        {value.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP' && (
          <Field
            label={value.bidStrategy === 'COST_CAP' ? 'Cost cap amount' : 'Bid cap amount'}
            hint="USD per result / per auction."
          >
            <DollarInput value={value.bidAmountUsd} onChange={(v) => set('bidAmountUsd', v)} />
          </Field>
        )}
      </Section>

      {/* -----------------------------------------------------------------
          Section: Page + destination
          ----------------------------------------------------------------- */}
      <Section title="Destination">
        <Field label="Facebook Page">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="text-fg-muted text-xs">
                {pages.length === 0
                  ? 'No pages cached yet.'
                  : `${pages.length} page${pages.length === 1 ? '' : 's'} available.`}
              </div>
              <button
                type="button"
                onClick={onRefreshPages}
                disabled={pagesRefreshing}
                className="text-primary text-xs underline-offset-4 hover:underline disabled:opacity-50"
              >
                {pagesRefreshing ? 'Refreshing…' : 'Refresh pages'}
              </button>
            </div>
            <select
              value={value.pageId}
              onChange={(e) => set('pageId', e.target.value)}
              className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            >
              <option value="">Select a page</option>
              {pages.map((p) => (
                <option key={p.pageId} value={p.pageId}>
                  {p.pageName} ({p.pageId})
                </option>
              ))}
            </select>
            {pagesError && (
              <p className="text-xs text-[color:var(--accent-negative)]">{pagesError}</p>
            )}
          </div>
        </Field>

        <Field label="Offer URL" hint="Where clicks send users.">
          <Input
            type="url"
            value={value.offerUrl}
            onChange={(e) => set('offerUrl', e.target.value)}
            placeholder="https://your-offer.example/landing"
          />
        </Field>

        <Field label="Call-to-action button">
          <select
            value={value.callToActionType}
            onChange={(e) => set('callToActionType', e.target.value as CallToActionType)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
          >
            {CTA_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {/* -----------------------------------------------------------------
          Section: Targeting
          ----------------------------------------------------------------- */}
      <Section title="Targeting">
        <Field label="Countries" hint="ISO-2 codes, comma-separated. e.g. US, CA, GB.">
          <Input
            type="text"
            value={value.targetingCountries.join(', ')}
            onChange={(e) =>
              set(
                'targetingCountries',
                e.target.value
                  .split(',')
                  .map((c) => c.trim().toUpperCase())
                  .filter(Boolean),
              )
            }
            placeholder="US, CA, GB"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Min age">
            <Input
              type="number"
              min={13}
              max={65}
              value={value.ageMin}
              onChange={(e) => set('ageMin', Number(e.target.value) || 13)}
            />
          </Field>
          <Field label="Max age">
            <Input
              type="number"
              min={13}
              max={65}
              value={value.ageMax}
              onChange={(e) => set('ageMax', Number(e.target.value) || 65)}
            />
          </Field>
        </div>

        <Field
          label="Advantage+ audience"
          hint="Let Meta find the best audience for your ads. Recommended."
        >
          <div className="flex gap-2">
            <ChipButton
              selected={value.advantageAudienceEnabled}
              onClick={() => set('advantageAudienceEnabled', true)}
              label="On"
            />
            <ChipButton
              selected={!value.advantageAudienceEnabled}
              onClick={() => set('advantageAudienceEnabled', false)}
              label="Off"
            />
          </div>
        </Field>

        <Field
          label="Languages"
          hint="Meta locale IDs, comma-separated. Leave empty to target all languages."
        >
          <Input
            type="text"
            value={value.locales.join(', ')}
            onChange={(e) =>
              set(
                'locales',
                e.target.value
                  .split(',')
                  .map((s) => Number(s.trim()))
                  .filter((n) => Number.isFinite(n) && n > 0),
              )
            }
            placeholder="6 (English), 24 (Spanish), 26 (French)…"
          />
        </Field>

        <Field
          label="Include custom audiences"
          hint="Audience IDs, comma-separated. Picker with live fetch ships in Polish-28.5."
        >
          <Input
            type="text"
            value={value.includedCustomAudienceIds.join(', ')}
            onChange={(e) =>
              set(
                'includedCustomAudienceIds',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="23851234567890123, 23859876543210987"
          />
        </Field>

        <Field label="Exclude custom audiences" hint="Same format as Include.">
          <Input
            type="text"
            value={value.excludedCustomAudienceIds.join(', ')}
            onChange={(e) =>
              set(
                'excludedCustomAudienceIds',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder=""
          />
        </Field>
      </Section>

      {/* -----------------------------------------------------------------
          Section: Placements
          ----------------------------------------------------------------- */}
      <Section title="Placements">
        <Field label="Placement mode">
          <div className="flex gap-2">
            <ChipButton
              selected={value.placementMode === 'advantage_plus'}
              onClick={() => set('placementMode', 'advantage_plus')}
              label="Advantage+ (recommended)"
            />
            <ChipButton
              selected={value.placementMode === 'manual'}
              onClick={() => set('placementMode', 'manual')}
              label="Manual"
            />
          </div>
          <p className="text-fg-muted mt-1.5 text-xs leading-relaxed">
            Advantage+: Meta shows your ads across the placements most likely to drive results.
            Manual: pick exactly where they run.
          </p>
        </Field>

        {value.placementMode === 'manual' && (
          <>
            <Field label="Platforms">
              <div className="flex flex-wrap gap-2">
                {PUBLISHER_PLATFORM_OPTIONS.map((p) => (
                  <ChipButton
                    key={p.value}
                    selected={value.publisherPlatforms.includes(p.value)}
                    onClick={() =>
                      set('publisherPlatforms', toggleInArray(value.publisherPlatforms, p.value))
                    }
                    label={p.label}
                  />
                ))}
              </div>
            </Field>

            {value.publisherPlatforms.includes('facebook') && (
              <Field label="Facebook positions">
                <PositionChips
                  all={FB_POSITIONS}
                  selected={value.facebookPositions}
                  onToggle={(pos) =>
                    set('facebookPositions', toggleInArray(value.facebookPositions, pos))
                  }
                />
              </Field>
            )}
            {value.publisherPlatforms.includes('instagram') && (
              <Field label="Instagram positions">
                <PositionChips
                  all={IG_POSITIONS}
                  selected={value.instagramPositions}
                  onToggle={(pos) =>
                    set('instagramPositions', toggleInArray(value.instagramPositions, pos))
                  }
                />
              </Field>
            )}
            {value.publisherPlatforms.includes('audience_network') && (
              <Field label="Audience Network positions">
                <PositionChips
                  all={AN_POSITIONS}
                  selected={value.audienceNetworkPositions}
                  onToggle={(pos) =>
                    set(
                      'audienceNetworkPositions',
                      toggleInArray(value.audienceNetworkPositions, pos),
                    )
                  }
                />
              </Field>
            )}
            {value.publisherPlatforms.includes('messenger') && (
              <Field label="Messenger positions">
                <PositionChips
                  all={MSGR_POSITIONS}
                  selected={value.messengerPositions}
                  onToggle={(pos) =>
                    set('messengerPositions', toggleInArray(value.messengerPositions, pos))
                  }
                />
              </Field>
            )}
          </>
        )}
      </Section>

      {/* -----------------------------------------------------------------
          Section: Schedule
          ----------------------------------------------------------------- */}
      <Section title="Schedule">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start" hint="Leave empty to start immediately.">
            <Input
              type="datetime-local"
              value={value.startTime}
              onChange={(e) => set('startTime', e.target.value)}
            />
          </Field>
          <Field label="End" hint="Leave empty to run until killed.">
            <Input
              type="datetime-local"
              value={value.endTime}
              onChange={(e) => set('endTime', e.target.value)}
            />
          </Field>
        </div>
        <p className="text-fg-muted text-xs">
          Times are interpreted in your browser&apos;s timezone and sent to Meta as UTC.
        </p>
      </Section>
    </div>
  );
}

/**
 * Convert a datetime-local string (browser TZ) to an ISO-8601 UTC
 * string Meta will accept. Empty in → empty out.
 */
export function toMetaISO(datetimeLocal: string): string {
  if (!datetimeLocal) return '';
  const d = new Date(datetimeLocal);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

// -----------------------------------------------------------------------------
// Reusable subcomponents
// -----------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-fg text-sm font-semibold uppercase tracking-wider">{title}</h3>
      <div className="border-border-subtle space-y-4 rounded-md border p-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-fg text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-fg-muted text-xs leading-relaxed">{hint}</p>}
    </div>
  );
}

function ChipButton({
  selected,
  onClick,
  label,
  disabled,
  title,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'rounded-md border px-3 py-1.5 text-xs transition-colors',
        selected
          ? 'border-fg bg-fg/10 text-fg font-medium'
          : 'border-border text-fg-muted hover:border-fg/50 hover:text-fg',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {label}
    </button>
  );
}

function PositionChips({
  all,
  selected,
  onToggle,
}: {
  all: string[];
  selected: string[];
  onToggle: (pos: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {all.map((pos) => (
        <ChipButton
          key={pos}
          selected={selected.includes(pos)}
          onClick={() => onToggle(pos)}
          label={pos.replace(/_/g, ' ')}
        />
      ))}
    </div>
  );
}

function DollarInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-fg-muted text-sm">$</span>
      <Input
        type="number"
        min={0}
        step="0.01"
        value={value === 0 ? '' : value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        placeholder="0.00"
      />
      <span className="text-fg-muted text-xs">/day</span>
    </div>
  );
}
