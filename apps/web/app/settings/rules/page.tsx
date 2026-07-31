import Link from 'next/link';
import { AlertTriangle, Pause, Skull, TrendingUp } from 'lucide-react';
import { eq } from 'drizzle-orm';
import {
  ASSUMED_CONVERSION_VALUE_USD,
  FIRST_LIVE_LAUNCH_HARD_CAP_USD,
  FIRST_SCALES_GRACE_COUNT,
  FIRST_SCALES_INCREMENT_PCT_CAP,
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  PLATFORM_HARD_CEILING_USD,
  PLATFORM_HARD_LAUNCH_CEILING_USD,
  SCALE_HARD_MULTIPLIER_CAP,
} from '@mbb/shared';
import { getDb, schema } from '@mbb/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Automation rules' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.2 Commit 16b: read-only surface for the automation
 * decision engine's thresholds. Answers "what will the bot do
 * automatically to my ads?" without making the user read
 * packages/shared/src/decision-engine.ts.
 *
 * Per-user thresholds come from user_settings (editable at
 * /settings). Hardcoded platform ceilings come from
 * packages/shared/src/safety.ts. Rules that are DOCUMENTED but
 * NOT IMPLEMENTED (auto-pause on rejection rate — see
 * apps/bot/src/handlers/suspicious-activity-monitor.ts) are
 * flagged with a "planned" badge so the operator knows what's
 * live vs promised.
 */
export default async function RulesPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: {
      killMaxCpcUsd: true,
      killNoConvSpendUsd: true,
      killMinCtrPct: true,
      scaleMinRoas: true,
      scaleMinSpendUsd: true,
      scaleIncrementPct: true,
      scaleMaxDailyBudgetUsd: true,
      pollingIntervalMinutes: true,
      platformDailySpendCeiling: true,
      dailyLaunchBudgetCapUsd: true,
      defaultAdDailyBudgetUsd: true,
    },
  });

  if (!settings) {
    throw new Error('user_settings row missing for authenticated user');
  }

  const n = (v: string | number | null) => Number(v ?? 0);

  return (
    <AppShell
      crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Automation rules' }]}
      contentClass="max-w-3xl"
    >
      <PageHeader
        title="Automation rules"
        subtitle="What the bot does automatically once ads are live. Edit thresholds in Settings."
      />

      <div className="mb-4 flex justify-end">
        <Link
          href="/settings"
          className="border-fg/30 hover:bg-bg-surfaceHover rounded-sm border px-3 py-1.5 text-xs font-medium"
        >
          Edit thresholds in Settings
        </Link>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Skull className="h-4 w-4" aria-hidden />
              Auto-kill
            </CardTitle>
            <CardDescription>
              The bot pauses an ad (recoverable: pause, not delete) when any rule below fires.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-fg text-sm">
              <RuleRow
                label="Spend without conversion"
                value={`Spend ≥ $${n(settings.killNoConvSpendUsd).toFixed(2)} AND conversions = 0 → kill`}
              />
              <RuleRow
                label="CPC ceiling"
                value={`CPC > $${n(settings.killMaxCpcUsd).toFixed(2)} AND spend ≥ $3 → kill`}
              />
              <RuleRow
                label="CTR floor"
                value={`CTR < ${n(settings.killMinCtrPct).toFixed(2)}% AND impressions ≥ 1000 → kill`}
              />
            </ul>
            <p className="text-fg-muted mt-3 text-xs">
              Kill means <strong>pause in Meta</strong>, not delete. You can re-activate in Ads
              Manager anytime. The rules re-evaluate every {settings.pollingIntervalMinutes}{' '}
              minutes.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4" aria-hidden />
              Auto-scale
            </CardTitle>
            <CardDescription>
              When an ad performs, the bot bumps its daily budget within safety caps.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-fg text-sm">
              <RuleRow
                label="Trigger"
                value={`Conversions > 0 AND spend ≥ $${n(settings.scaleMinSpendUsd).toFixed(2)} AND ROAS ≥ ${n(settings.scaleMinRoas).toFixed(2)}x`}
              />
              <RuleRow
                label="Increment"
                value={`+${n(settings.scaleIncrementPct).toFixed(0)}% of current budget per event`}
              />
              <RuleRow
                label="Per-ad ceiling"
                value={`$${n(settings.scaleMaxDailyBudgetUsd).toFixed(2)} / day`}
              />
              <RuleRow
                label="Hard multiplier cap"
                value={`No single scale > ${SCALE_HARD_MULTIPLIER_CAP}× previous budget`}
              />
              <RuleRow
                label="Cold-start throttle"
                value={`First ${FIRST_SCALES_GRACE_COUNT} scales capped at +${FIRST_SCALES_INCREMENT_PCT_CAP}%`}
              />
            </ul>
            <p className="text-fg-muted mt-3 text-xs">
              ROAS uses an assumed conversion value of ${ASSUMED_CONVERSION_VALUE_USD.toFixed(2)}.
              Real conversion values land in a future update.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Pause className="h-4 w-4" aria-hidden />
              Account-level auto-pause
            </CardTitle>
            <CardDescription>
              Whole-account pauses. Recoverable from the dashboard banner in every case.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-fg text-sm">
              <RuleRow
                label="Cascade pause"
                value="Meta or AI provider disconnects → pause all launches until reconnected"
              />
              <RuleRow
                label="Rejection-rate pause"
                value=">30% ad rejections in 24h → pause all launches"
                planned
              />
              <RuleRow
                label="Consecutive-rejection pause"
                value="3 same-reason rejections in a row → pause all launches"
                planned
              />
              <RuleRow
                label="BM access failure"
                value="Meta access to the Business Manager revoked → pause"
                planned
              />
            </ul>
            <p className="text-fg-muted mt-3 text-xs">
              Rules marked <em>planned</em> are documented in the anti-ban monitor but not live yet.
              Cascade pause is fully live.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              Platform hard ceilings
            </CardTitle>
            <CardDescription>
              Absolute clamps. The bot can never exceed these no matter what you set in Settings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-fg text-sm">
              <RuleRow
                label="First live launch"
                value={`Total daily exposure ≤ $${FIRST_LIVE_LAUNCH_HARD_CAP_USD.toFixed(2)} until the first successful launch`}
              />
              <RuleRow
                label="Daily launch budget"
                value={`Your setting: $${n(settings.dailyLaunchBudgetCapUsd).toFixed(2)} · Platform ceiling: $${PLATFORM_HARD_LAUNCH_CEILING_USD.toFixed(2)}`}
              />
              <RuleRow
                label="Daily Meta spend"
                value={`Your setting: $${n(settings.platformDailySpendCeiling).toFixed(2)} · Platform ceiling: $${PLATFORM_HARD_CEILING_USD.toFixed(2)}`}
              />
              <RuleRow
                label="Per-ad daily budget"
                value={`Your setting: $${n(settings.defaultAdDailyBudgetUsd).toFixed(2)} · Platform ceiling: $${PLATFORM_HARD_AD_DAILY_BUDGET_USD.toFixed(2)}`}
              />
            </ul>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function RuleRow({
  label,
  value,
  planned = false,
}: {
  label: string;
  value: string;
  planned?: boolean;
}) {
  return (
    <li className="border-border-subtle flex flex-col gap-1 border-b py-2 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <div className="flex items-center gap-2">
        <span className="text-fg-muted min-w-[140px] text-xs uppercase tracking-wider">
          {label}
        </span>
        {planned && (
          <span className="border-fg-subtle text-fg-subtle rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
            planned
          </span>
        )}
      </div>
      <span className="text-fg font-mono text-xs sm:text-right">{value}</span>
    </li>
  );
}
