import { eq } from 'drizzle-orm';
import {
  checkActiveSubscription,
  checkAdAccountSlotQuota,
  getDb,
  getUserSettings,
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
  const [sub, quota] = await Promise.all([
    checkActiveSubscription(userId),
    checkAdAccountSlotQuota({ userId }),
  ]);

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
      <PageHeader
        title="Settings"
        subtitle="Bot configuration. Changes apply on the next launch / poll cycle."
      />

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
