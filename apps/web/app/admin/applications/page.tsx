import { asc, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { formatDateTime } from '@/lib/format/date';
import { requireAdmin } from '@/lib/admin-gate';
import { ApplicationsClient } from './applications-client';

export const metadata = { title: 'Applications — Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminApplicationsPage() {
  await requireAdmin();
  const db = getDb();
  const pending = await db.query.applications.findMany({
    where: eq(schema.applications.status, 'pending'),
    orderBy: asc(schema.applications.createdAt),
  });
  const processed = await db.query.applications.findMany({
    where: (a, { inArray }) => inArray(a.status, ['approved', 'paid', 'rejected']),
    orderBy: desc(schema.applications.createdAt),
    limit: 100,
  });

  return (
    <AppShell crumbs={[{ label: 'Admin' }, { label: 'Applications' }]}>
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Applications</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Approve generates a Whop checkout link + an invite code, then emails the applicant (Resend
          or stub).
        </p>
      </header>

      <ApplicationsClient pending={pending.map(serialize)} processed={processed.map(serialize)} />
    </AppShell>
  );
}

function serialize(a: typeof schema.applications.$inferSelect) {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    agencyName: a.agencyName,
    monthlyAdSpendUsd: a.monthlyAdSpendUsd,
    verticals: a.verticals,
    whyApply: a.whyApply,
    heardFrom: a.heardFrom,
    status: a.status,
    whopCheckoutUrl: a.whopCheckoutUrl,
    rejectedReason: a.rejectedReason,
    createdAtLabel: formatDateTime(a.createdAt),
    approvedAtLabel: a.approvedAt ? formatDateTime(a.approvedAt) : null,
    paidAtLabel: a.paidAt ? formatDateTime(a.paidAt) : null,
  };
}
