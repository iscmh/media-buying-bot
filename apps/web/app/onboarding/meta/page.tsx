import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { requireOnboardingStep } from '@/lib/onboarding-gate';
import { listMetaResources } from './actions';
import { MetaTokenPasteForm } from './token-form';
import { MetaSelectionForm } from './selection-form';
import { MetaConnectedSummary } from './connected-summary';

export const metadata = { title: 'Connect Meta — Media Buying Bot' };

export default async function OnboardingMetaPage() {
  // allowComplete: page renders summary card if user is already connected.
  const { userId, state } = await requireOnboardingStep('meta', { allowComplete: true });

  const db = getDb();
  const conn = await db.query.metaConnections.findFirst({
    where: and(eq(schema.metaConnections.userId, userId), isNull(schema.metaConnections.deletedAt)),
    columns: {
      status: true,
      businessManagerId: true,
      adAccountIds: true,
      tokenExpiresAt: true,
    },
  });

  // Sub-state (c): already connected, show summary.
  if (state.completed.meta && conn?.status === 'active' && conn.businessManagerId) {
    return (
      <MetaConnectedSummary
        businessManagerId={conn.businessManagerId}
        adAccountIds={conn.adAccountIds ?? []}
        tokenExpiresAt={conn.tokenExpiresAt}
      />
    );
  }

  // Sub-state (b): token verified, status='pending', show selection.
  if (conn?.status === 'pending' && conn.tokenExpiresAt) {
    const resources = await listMetaResources(userId);
    if ('error' in resources) {
      return <ResourceError message={resources.error} />;
    }
    return (
      <MetaSelectionForm businesses={resources.businesses} adAccounts={resources.adAccounts} />
    );
  }

  // Sub-state (a): no token yet (or status != pending/active), show paste form.
  return <MetaTokenPasteForm />;
}

function ResourceError({ message }: { message: string }) {
  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Connect Meta</h1>
      </header>
      <div className="border-destructive/50 bg-destructive/5 rounded-lg border p-6 text-sm">
        <p className="font-semibold">Couldn’t list your Business Managers and ad accounts.</p>
        <p className="text-muted-foreground mt-2">{message}</p>
      </div>
    </article>
  );
}
