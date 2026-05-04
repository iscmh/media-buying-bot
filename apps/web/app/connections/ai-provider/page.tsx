import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { AI_PROVIDER_META, type AIProviderName } from '@mbb/shared';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ProviderConnectForm } from './connect-form';
import { ProviderConnectedSummary } from './connected-summary';

export const metadata = { title: 'AI provider — Media Buying Bot' };

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
      <main className="container mx-auto max-w-2xl px-4 py-12">
        <header className="mb-6">
          <h1 className="text-3xl font-bold">AI UGC provider</h1>
        </header>
        <ProviderConnectedSummary
          provider={conn.provider as AIProviderName}
          providerLabel={meta.label}
          verificationMethod={meta.verificationMethod}
          apiKeyVerifiedAt={conn.apiKeyVerifiedAt}
        />
      </main>
    );
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">AI UGC provider</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Pick one. Bring your own API key. We encrypt it at rest and use it on your behalf during
          generation.
        </p>
      </header>
      <ProviderConnectForm />
    </main>
  );
}
