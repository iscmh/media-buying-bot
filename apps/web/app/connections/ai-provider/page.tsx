import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { AI_PROVIDER_META, type AIProviderName } from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ProviderConnectForm } from './connect-form';
import { ProviderConnectedSummary } from './connected-summary';

export const metadata = { title: 'AI provider' };

export default async function ConnectAIProviderPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();
  const conn = await db.query.aiProviderConnections.findFirst({
    where: and(
      eq(schema.aiProviderConnections.userId, userId),
      isNull(schema.aiProviderConnections.deletedAt),
    ),
    columns: {
      provider: true,
      apiKeyVerifiedAt: true,
      status: true,
    },
  });

  if (conn?.status === 'active') {
    const meta = AI_PROVIDER_META[conn.provider as AIProviderName];
    return (
      <AppShell
        crumbs={[{ label: 'Connections' }, { label: 'AI provider' }]}
        contentClass="max-w-2xl"
      >
        <header className="mb-6">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">AI UGC provider</h1>
        </header>
        <ProviderConnectedSummary
          provider={conn.provider as AIProviderName}
          providerLabel={meta.label}
          verificationMethod={meta.verificationMethod}
          apiKeyVerifiedAt={conn.apiKeyVerifiedAt}
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      crumbs={[{ label: 'Connections' }, { label: 'AI provider' }]}
      contentClass="max-w-2xl"
    >
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">AI UGC provider</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Pick one. Bring your own API key. We encrypt it at rest and use it on your behalf during
          generation.
        </p>
      </header>
      <ProviderConnectForm />
    </AppShell>
  );
}
