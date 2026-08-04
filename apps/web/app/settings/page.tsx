import Link from 'next/link';
import { BookOpen, KeyRound, LayoutList } from 'lucide-react';
import { eq } from 'drizzle-orm';
import {
  checkActiveSubscription,
  checkAdAccountSlotQuota,
  getDb,
  getLatestPauseReason,
  getUserSettings,
  isMetaConnected,
  schema,
} from '@mbb/db';
import {
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  PLATFORM_HARD_AI_CEILING_USD,
  PLATFORM_HARD_CEILING_USD,
  PLATFORM_HARD_LAUNCH_CEILING_USD,
} from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { PauseBanner } from '../dashboard/_components/pause-banner';
import { AutomationAcks } from './automation-acks';
import { BillingSection } from './billing-section';
import { HeygenAvatarSection } from './heygen-avatar-section';
import { SettingsForm } from './settings-form';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const { userId } = await requireOnboardingComplete();
  const current = await getUserSettings(userId);
  if (!current) {
    // Should never happen — the auth.users → user_settings trigger seeds
    // a row on signup. Surface loudly if it does.
    throw new Error('user_settings row missing for authenticated user');
  }

  // Cached Meta Pages drive the Default Page picker. We do NOT live-fetch
  // on every settings load — the cache is refreshed on demand from the
  // dialog / settings refresh button.
  const db = getDb();
  const metaPagesRows = await db.query.metaPages.findMany({
    where: eq(schema.metaPages.userId, userId),
    columns: { pageId: true, pageName: true },
  });

  // Kill/scale ack flags + last-saved timestamp from user_settings.
  const settingsMeta = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: {
      killAcknowledgedAt: true,
      scaleAcknowledgedAt: true,
      updatedAt: true,
    },
  });

  // Phase 8 billing snapshot (subscription status + ad-account slot quota).
  // Polish-25.7 Commit 43: also fetch pause state + Meta connection so the
  // /settings header can render the same pause banner as /dashboard.
  // Operators land on /settings to fix disconnects and need the same
  // unpause path visible here.
  const [sub, quota, userRow, metaConnected] = await Promise.all([
    checkActiveSubscription(userId),
    checkAdAccountSlotQuota({ userId }),
    db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { isPaused: true },
    }),
    isMetaConnected(userId),
  ]);
  const pauseReason = userRow?.isPaused ? await getLatestPauseReason(userId) : null;

  // Server-render the three non-form panels and hand them into the
  // client form. Allows the client SettingsForm to slot them into the
  // Tabs panel without re-doing the data fetches client-side.
  const acksPanel = (
    <AutomationAcks
      killAcknowledgedAt={settingsMeta?.killAcknowledgedAt?.toISOString() ?? null}
      scaleAcknowledgedAt={settingsMeta?.scaleAcknowledgedAt?.toISOString() ?? null}
    />
  );

  const avatarPanel = <HeygenAvatarSection userId={userId} />;

  const accountPanel = (
    <BillingSection
      isFoundingMember={sub.isFoundingMember}
      plan={sub.plan ?? null}
      status={
        sub.isFoundingMember
          ? null
          : sub.reason === 'active'
            ? 'active'
            : sub.reason === 'past_due'
              ? 'past_due'
              : sub.reason === 'canceled'
                ? 'canceled'
                : sub.reason === 'expired'
                  ? 'expired'
                  : null
      }
      currentPeriodEnd={sub.currentPeriodEnd ?? null}
      adAccountSlotsUsed={quota.used}
      adAccountSlotsLimit={quota.limit}
      whopAddonProductId={process.env.WHOP_ADDON_PRODUCT_ID_AD_ACCOUNT ?? null}
    />
  );

  return (
    <AppShell crumbs={[{ label: 'Settings' }]} contentClass="max-w-4xl">
      {pauseReason && (
        <PauseBanner
          reason={pauseReason.reason}
          pausedAt={pauseReason.pausedAt}
          openPauseCount={pauseReason.openPauseCount}
          openReasons={pauseReason.openReasons}
          pausedBy={pauseReason.pausedBy}
          metaStillDisconnected={!metaConnected}
        />
      )}

      <PageHeader
        title="Settings"
        subtitle="Bot configuration. Changes apply on the next launch / poll cycle."
      />

      {/* Polish-25.2 Commit 16b: quick-nav to the sub-pages so operators
          don't have to guess URLs. Polish-25.10 Commit 59 added the
          third card for API keys (Scale-tier surface). */}
      <div className="mb-6 grid gap-2 sm:grid-cols-3">
        <Link
          href="/settings/presets"
          className="border-border-subtle hover:bg-bg-surfaceHover group flex items-start gap-3 rounded-md border p-3 text-sm"
        >
          <LayoutList className="text-fg-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="text-fg font-medium">Launch presets</p>
            <p className="text-fg-muted mt-0.5 text-xs">
              Save reusable bundles of launch settings for one-click apply on the launch dialog.
            </p>
          </div>
        </Link>
        <Link
          href="/settings/rules"
          className="border-border-subtle hover:bg-bg-surfaceHover group flex items-start gap-3 rounded-md border p-3 text-sm"
        >
          <BookOpen className="text-fg-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="text-fg font-medium">Automation rules</p>
            <p className="text-fg-muted mt-0.5 text-xs">
              What the bot does automatically once ads are live: kill / scale / pause thresholds.
            </p>
          </div>
        </Link>
        <Link
          href="/settings/api"
          className="border-border-subtle hover:bg-bg-surfaceHover group flex items-start gap-3 rounded-md border p-3 text-sm"
        >
          <KeyRound className="text-fg-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="text-fg font-medium">API keys</p>
            <p className="text-fg-muted mt-0.5 text-xs">
              Bearer tokens for /api/v1. Drive uploads, generation, and Meta launch from your own
              scripts.
            </p>
          </div>
        </Link>
      </div>

      <SettingsForm
        initialValues={current}
        hardCeiling={PLATFORM_HARD_CEILING_USD}
        aiHardCeiling={PLATFORM_HARD_AI_CEILING_USD}
        launchHardCeiling={PLATFORM_HARD_LAUNCH_CEILING_USD}
        adDailyHardCeiling={PLATFORM_HARD_AD_DAILY_BUDGET_USD}
        metaPages={metaPagesRows}
        lastSavedAt={settingsMeta?.updatedAt?.toISOString() ?? null}
        acksPanel={acksPanel}
        avatarPanel={avatarPanel}
        accountPanel={accountPanel}
      />
    </AppShell>
  );
}
