import { listWaitlistEntries } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { formatDateTime } from '@/lib/format/date';
import { requireAdmin } from '@/lib/admin-gate';
import { WaitlistAdminClient } from './waitlist-admin-client';

export const metadata = { title: 'Waitlist - Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminWaitlistPage() {
  await requireAdmin();
  const all = await listWaitlistEntries();
  const unapproved = all.filter((e) => !e.approvedAt);
  const approved = all.filter((e) => e.approvedAt);

  return (
    <AppShell crumbs={[{ label: 'Admin' }, { label: 'Waitlist' }]} contentClass="max-w-5xl">
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Waitlist</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Approve gets a fresh single-use invite code + emails it (or logs the payload if
          RESEND_API_KEY isn&apos;t set).
        </p>
      </header>

      <WaitlistAdminClient
        unapproved={unapproved.map((e) => ({
          id: e.id,
          email: e.email,
          name: e.name,
          source: e.source,
          message: e.message,
          createdAtIso: e.createdAt.toISOString(),
        }))}
        approved={approved.map((e) => ({
          id: e.id,
          email: e.email,
          name: e.name,
          source: e.source,
          createdAtIso: e.createdAt.toISOString(),
          approvedAtIso: e.approvedAt!.toISOString(),
        }))}
      />

      <p className="text-fg-muted mt-6 text-xs">Server time: {formatDateTime(new Date())}.</p>
    </AppShell>
  );
}
