import { getAdminActivityRows } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireAdmin } from '@/lib/admin-gate';
import { ActivityTable } from './activity-table';

export const metadata = { title: 'Activity - Admin' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.7 Commit 44: admin-only beta activity dashboard.
 *
 * One row per user with connection state, pipeline counts, launched-ad
 * counts, and last activity. Used to spot testers who signed up but
 * haven't generated, or who are stuck on failed generations, or whose
 * bot has been paused for days.
 *
 * Read-only — no user actions surface here. Auth-gated via
 * requireAdmin() which silently redirects non-admins to /dashboard so
 * the route's existence doesn't leak.
 */
export default async function AdminActivityPage() {
  await requireAdmin();
  const rows = await getAdminActivityRows();
  // Serialize dates to ISO strings for the client boundary — Server
  // Component → Client Component transport can't cross Date objects
  // without extra rules, and ISO strings sort/display cleanly.
  const serialized = rows.map((r) => ({
    ...r,
    signupAt: r.signupAt.toISOString(),
    lastActivityAt: r.lastActivityAt ? r.lastActivityAt.toISOString() : null,
  }));
  return (
    <AppShell crumbs={[{ label: 'Admin' }, { label: 'Activity' }]}>
      <PageHeader
        title="Beta activity"
        subtitle={`${rows.length} user${rows.length === 1 ? '' : 's'} · connections, pipeline counts, last activity`}
      />
      <ActivityTable rows={serialized} />
    </AppShell>
  );
}
