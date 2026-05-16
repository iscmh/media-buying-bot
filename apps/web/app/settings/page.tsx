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
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { AutomationAcks } from './automation-acks';
import { BillingSection } from './billing-section';
import { HeygenAvatarSection } from './heygen-avatar-section';
import { SettingsForm } from './settings-form';

export const metadata = { title: 'Settings — Ads Bot' };

export default async function SettingsPage() {
  const { userId } = await requireOnboardingComplete();
  const current = await getUserSettings(userId);
  if (!current) {
    // Should never happen — the auth.users → user_settings trigger seeds
    // a row on signup. Surface loudly if it does.
    throw new Error('user_settings row missing for authenticated user');
  }

  // Phase 4b: cached Meta Pages drive the Default Page picker. We do
  // NOT live-fetch from Meta on every settings load — the cache is
  // refreshed on demand from the dialog / settings refresh button so
  // the load stays cheap and unaffected by Meta downtime.
  const db = getDb();
  const metaPagesRows = await db.query.metaPages.findMany({
    where: eq(schema.metaPages.userId, userId),
    columns: { pageId: true, pageName: true },
  });

  // Phase 5: kill/scale ack flags drive the Automation acks card state
  // (read-only display + first-time confirm buttons).
  const ackSettings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { killAcknowledgedAt: true, scaleAcknowledgedAt: true },
  });

  // Phase 8: billing card snapshot (subscription status + ad-account
  // slot quota). The /billing-required gate already handles the
  // hard-no-access path; on /settings we just surface the state.
  const [sub, quota] = await Promise.all([
    checkActiveSubscription(userId),
    checkAdAccountSlotQuota({ userId }),
  ]);

  return (
    <AppShell crumbs={[{ label: 'Settings' }]} contentClass="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Bot configuration. Changes apply on the next launch / poll cycle.
        </p>
      </header>

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

      <AutomationAcks
        killAcknowledgedAt={ackSettings?.killAcknowledgedAt?.toISOString() ?? null}
        scaleAcknowledgedAt={ackSettings?.scaleAcknowledgedAt?.toISOString() ?? null}
      />

      <HeygenAvatarSection userId={userId} />

      <SettingsForm
        initialValues={current}
        hardCeiling={PLATFORM_HARD_CEILING_USD}
        aiHardCeiling={PLATFORM_HARD_AI_CEILING_USD}
        launchHardCeiling={PLATFORM_HARD_LAUNCH_CEILING_USD}
        adDailyHardCeiling={PLATFORM_HARD_AD_DAILY_BUDGET_USD}
        metaPages={metaPagesRows}
      />
    </AppShell>
  );
}
