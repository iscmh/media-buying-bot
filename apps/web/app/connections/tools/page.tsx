import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { TOOL_PROVIDERS_ORDER, TOOL_PROVIDER_META, type ToolProviderName } from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ToolCard } from './tool-card';

export const metadata = { title: 'AI tools' };

export default async function ConnectToolsPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const rows = await db.query.toolConnections.findMany({
    where: and(eq(schema.toolConnections.userId, userId), isNull(schema.toolConnections.deletedAt)),
    columns: { provider: true, apiKeyVerifiedAt: true, status: true },
  });

  const byProvider = new Map<ToolProviderName, (typeof rows)[number]>();
  for (const r of rows) byProvider.set(r.provider as ToolProviderName, r);

  return (
    <AppShell crumbs={[{ label: 'Connections' }, { label: 'Tools' }]} contentClass="max-w-2xl">
      <header className="mb-8">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">AI tools</h1>
        <p className="text-fg-muted mt-1 text-sm">
          BYOK keys for Gemini (vision + image), Claude (copy + prompts), and Kie.ai (Sora 2 video).
          Distinct from your UGC video providers (HeyGen / Arcads). Phase 3a verifies key format
          only — real verification happens at first generation.
        </p>
      </header>

      <div className="space-y-4">
        {TOOL_PROVIDERS_ORDER.map((provider) => {
          const meta = TOOL_PROVIDER_META[provider];
          const conn = byProvider.get(provider);
          return (
            <ToolCard
              key={provider}
              provider={provider}
              label={meta.label}
              role={meta.role}
              description={meta.description}
              apiDocsUrl={meta.apiDocsUrl}
              keyHint={meta.keyHint}
              connected={conn?.status === 'active'}
              verifiedDisplay={conn ? formatDateTime(conn.apiKeyVerifiedAt) : null}
            />
          );
        })}
      </div>
    </AppShell>
  );
}
