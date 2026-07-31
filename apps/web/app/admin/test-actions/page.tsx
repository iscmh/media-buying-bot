import { AppShell } from '@/components/shell/app-shell';
import { requireAdmin } from '@/lib/admin-gate';
import { loadTestableAds } from './actions';
import { TestActionsClient } from './test-actions-client';

export const metadata = { title: 'Test actions - Admin' };

export default async function TestActionsPage() {
  await requireAdmin();
  const ads = await loadTestableAds();

  return (
    <AppShell crumbs={[{ label: 'Admin' }, { label: 'Test actions' }]} contentClass="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Test actions</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Manually invoke kill, scale, or daily summary against existing launched ads. Each button
          creates a real pending_approval + dispatches the Inngest event. Watch the Inngest
          dashboard for the function run.
        </p>
      </header>

      <TestActionsClient ads={ads} />
    </AppShell>
  );
}
