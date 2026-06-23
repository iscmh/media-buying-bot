import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { formatDate } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { DisconnectedNotice } from '../_shared/disconnected-notice';
import { MetaConnectedSummary } from './connected-summary';

export const metadata = { title: 'Meta connection' };

export default async function ConnectMetaPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();
  const conn = await db.query.metaConnections.findFirst({
    where: and(eq(schema.metaConnections.userId, userId), isNull(schema.metaConnections.deletedAt)),
    columns: {
      businessManagerId: true,
      adAccountIds: true,
      tokenExpiresAt: true,
      lastVerifiedAt: true,
      // Polish-3.5: surface account currency + tz + page count on the
      // connected card so the user can see what the launch path is using.
      accountCurrency: true,
      accountTimezone: true,
      pages: true,
    },
  });

  // requireOnboardingComplete already redirected if Meta isn't connected,
  // so conn should always be present here. Defensive fallback for race
  // conditions (disconnect just happened, page rendered before redirect):
  // surface "Last connected ... Reconnect →" instead of an empty state.
  if (!conn || !conn.businessManagerId) {
    const lastRevoked = await db.query.metaConnections.findFirst({
      where: and(
        eq(schema.metaConnections.userId, userId),
        ne(schema.metaConnections.status, 'active'),
      ),
      orderBy: desc(schema.metaConnections.deletedAt),
      columns: { deletedAt: true },
    });
    return (
      <AppShell crumbs={[{ label: 'Connections' }, { label: 'Meta' }]} contentClass="max-w-2xl">
        <PageHeader
          title="Meta connection"
          subtitle="BYO token — you own the credential, we never see your password."
        />
        <DisconnectedNotice
          reconnectHref="/onboarding/meta"
          detail={
            lastRevoked?.deletedAt ? `Last connected ${formatDate(lastRevoked.deletedAt)}` : null
          }
        />
      </AppShell>
    );
  }

  return (
    <AppShell crumbs={[{ label: 'Connections' }, { label: 'Meta' }]} contentClass="max-w-2xl">
      <PageHeader
        title="Meta connection"
        subtitle="BYO token — you own the credential, we never see your password."
      />

      <MetaConnectedSummary
        businessManagerId={conn.businessManagerId}
        adAccountIds={conn.adAccountIds ?? []}
        tokenExpiresAt={conn.tokenExpiresAt}
        lastVerifiedAt={conn.lastVerifiedAt}
        accountCurrency={conn.accountCurrency ?? null}
        accountTimezone={conn.accountTimezone ?? null}
        pageCount={(conn.pages ?? []).length}
      />
    </AppShell>
  );
}
