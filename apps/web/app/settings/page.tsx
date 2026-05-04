import { getUserSettings } from '@mbb/db';
import { PLATFORM_HARD_CEILING_USD } from '@mbb/shared';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { SettingsForm } from './settings-form';

export const metadata = { title: 'Settings — Media Buying Bot' };

export default async function SettingsPage() {
  const { userId } = await requireOnboardingComplete();
  const current = await getUserSettings(userId);
  if (!current) {
    // Should never happen — the auth.users → user_settings trigger seeds
    // a row on signup. Surface loudly if it does.
    throw new Error('user_settings row missing for authenticated user');
  }

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Bot configuration. Changes apply on the next launch / poll cycle.
        </p>
      </header>

      <SettingsForm initialValues={current} hardCeiling={PLATFORM_HARD_CEILING_USD} />
    </main>
  );
}
