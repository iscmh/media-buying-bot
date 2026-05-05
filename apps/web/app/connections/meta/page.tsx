import Link from 'next/link';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { MetaConnectedSummary } from './connected-summary';

export const metadata = { title: 'Meta connection — Media Buying Bot' };

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
      <main className="container mx-auto max-w-2xl px-4 py-12">
        <h1 className="mb-2 text-3xl font-bold">Meta connection</h1>
        <p className="text-destructive text-sm">
          Disconnected
          {lastRevoked?.deletedAt && (
            <> · last connected {lastRevoked.deletedAt.toLocaleDateString()}</>
          )}
          .{' '}
          <Link href="/onboarding/meta" className="underline">
            Reconnect →
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Meta connection</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          BYO token — you own the credential, we never see your password.
        </p>
      </header>

      <MetaConnectedSummary
        businessManagerId={conn.businessManagerId}
        adAccountIds={conn.adAccountIds ?? []}
        tokenExpiresAt={conn.tokenExpiresAt}
        lastVerifiedAt={conn.lastVerifiedAt}
      />
    </main>
  );
}
