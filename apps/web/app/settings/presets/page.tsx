import { META_OPTIMIZATION_GOALS, META_PLACEMENT_TYPES } from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { loadPresetsForUser } from './actions';
import { PresetsManager } from './presets-manager';

export const metadata = { title: 'Launch presets' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.2 Commit 16b: named launch-preset CRUD. Users save a
 * bundle of (countries, age range, optimization goal, placement
 * type, per-ad daily budget) as a named preset and apply it from
 * the launch dialog dropdown instead of re-typing the same values
 * every time.
 *
 * MVP: list + create + edit + delete. No preset-usage counter, no
 * "last used" timestamp, no default flag.
 */
export default async function PresetsPage() {
  const { userId } = await requireOnboardingComplete();
  const presets = await loadPresetsForUser(userId);

  return (
    <AppShell
      crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Launch presets' }]}
      contentClass="max-w-3xl"
    >
      <PageHeader
        title="Launch presets"
        subtitle="Named bundles of launch settings. Pick one from the launch dialog to skip re-typing targeting, budget, and optimization goal."
      />
      <PresetsManager
        initial={presets}
        optimizationGoals={[...META_OPTIMIZATION_GOALS]}
        placementTypes={[...META_PLACEMENT_TYPES]}
      />
    </AppShell>
  );
}
