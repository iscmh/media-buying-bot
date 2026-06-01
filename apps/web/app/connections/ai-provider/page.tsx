import { and, eq, isNull, inArray } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { CONNECTABLE_AI_PROVIDERS, type AIProviderName } from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ProviderCard } from './provider-card';

export const metadata = { title: 'AI providers' };

/**
 * Polish-8: multi-provider connections page. One card per provider
 * the user can connect (HeyGen, Replicate, Gemini, OpenAI, ElevenLabs).
 * Arcads + Creatify cards removed — legacy DB rows still exist but
 * the UI no longer surfaces them.
 */
export default async function ConnectAIProviderPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const rows = await db.query.aiProviderConnections.findMany({
    where: and(
      eq(schema.aiProviderConnections.userId, userId),
      eq(schema.aiProviderConnections.status, 'active'),
      isNull(schema.aiProviderConnections.deletedAt),
      inArray(schema.aiProviderConnections.provider, CONNECTABLE_AI_PROVIDERS),
    ),
    columns: {
      provider: true,
      apiKeyVerifiedAt: true,
      lastVerifiedAt: true,
      tier: true,
    },
  });
  const byProvider = new Map(rows.map((r) => [r.provider as AIProviderName, r]));

  return (
    <AppShell
      crumbs={[{ label: 'Connections' }, { label: 'AI providers' }]}
      contentClass="max-w-3xl"
    >
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">AI providers</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Connect the keys your generation pipelines need. The bot auto-routes uploaded reference
          creatives to the pipeline matching what you have connected. For Gemini (vision + image
          generation), use{' '}
          <a href="/connections/tools" className="hover:text-fg underline">
            /connections/tools
          </a>
          .
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {CONNECTABLE_AI_PROVIDERS.map((provider) => {
          const row = byProvider.get(provider);
          return (
            <ProviderCard
              key={provider}
              provider={provider}
              connected={
                row
                  ? {
                      apiKeyVerifiedAt: row.apiKeyVerifiedAt,
                      lastVerifiedAt: row.lastVerifiedAt,
                      tier: row.tier,
                    }
                  : null
              }
            />
          );
        })}
      </div>
    </AppShell>
  );
}
