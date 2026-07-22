import Link from 'next/link';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import {
  CONNECTABLE_AI_PROVIDERS,
  TOOL_PROVIDERS_ORDER,
  TOOL_PROVIDER_META,
  type AIProviderName,
  type ToolProviderName,
} from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ProviderCard } from '@/app/connections/ai-provider/provider-card';
import { ToolCard } from '@/app/connections/tools/tool-card';
import { MetaConnectedSummary } from '@/app/connections/meta/connected-summary';
import { TelegramConnectedSummary } from '@/app/connections/telegram/connected-summary';
import { DisconnectedNotice } from '@/app/connections/_shared/disconnected-notice';

export const metadata = { title: 'Connections' };
export const dynamic = 'force-dynamic';

type Tab = 'providers' | 'meta' | 'telegram';
const VALID_TABS: readonly Tab[] = ['providers', 'meta', 'telegram'];

interface Props {
  searchParams: Promise<{ tab?: string }>;
}

/**
 * Polish-25.1 Commit 10a: consolidated connections surface.
 *
 * Replaces the 4 pre-Commit-10 pages
 *   /connections/ai-provider
 *   /connections/tools
 *   /connections/meta
 *   /connections/telegram
 * with a single 3-tab page. Each old route is preserved as a
 * redirect stub for bookmarks — see /connections/*.
 *
 * Tabs are URL-driven (`?tab=providers|meta|telegram`) so the page
 * stays server-rendered end-to-end + individual tabs are
 * bookmark-linkable.
 */
export default async function SettingsConnectionsPage({ searchParams }: Props) {
  const { userId } = await requireOnboardingComplete();
  const { tab: tabParam } = await searchParams;
  const tab: Tab = (VALID_TABS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as Tab)
    : 'providers';

  return (
    <AppShell crumbs={[{ label: 'Settings' }, { label: 'Connections' }]} contentClass="max-w-3xl">
      <PageHeader
        title="Connections"
        subtitle="AI providers, ad accounts, and notifications — all in one place."
      />

      <nav
        className="border-border-subtle mb-6 flex gap-1 border-b"
        aria-label="Connection sections"
      >
        <TabLink current={tab} target="providers" label="Providers" />
        <TabLink current={tab} target="meta" label="Meta" />
        <TabLink current={tab} target="telegram" label="Telegram" />
      </nav>

      {tab === 'providers' && <ProvidersTab userId={userId} />}
      {tab === 'meta' && <MetaTab userId={userId} />}
      {tab === 'telegram' && <TelegramTab userId={userId} />}
    </AppShell>
  );
}

function TabLink({ current, target, label }: { current: Tab; target: Tab; label: string }) {
  const active = current === target;
  return (
    <Link
      href={`/settings/connections?tab=${target}`}
      className={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
        active ? 'border-fg text-fg' : 'text-fg-muted hover:text-fg border-transparent',
      )}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

// ---------------------------------------------------------------
// Providers tab: Polish-25 required (Claude / Gemini / MakeUGC) at
// the top, then the optional providers as an "Advanced" list.
// ---------------------------------------------------------------

async function ProvidersTab({ userId }: { userId: string }) {
  const db = getDb();
  const [toolRows, aiRows] = await Promise.all([
    db.query.toolConnections.findMany({
      where: and(
        eq(schema.toolConnections.userId, userId),
        isNull(schema.toolConnections.deletedAt),
      ),
      columns: { provider: true, apiKeyVerifiedAt: true, status: true },
    }),
    db.query.aiProviderConnections.findMany({
      where: and(
        eq(schema.aiProviderConnections.userId, userId),
        eq(schema.aiProviderConnections.status, 'active'),
        isNull(schema.aiProviderConnections.deletedAt),
        inArray(schema.aiProviderConnections.provider, CONNECTABLE_AI_PROVIDERS),
      ),
      columns: { provider: true, apiKeyVerifiedAt: true, lastVerifiedAt: true, tier: true },
    }),
  ]);
  const toolByProvider = new Map<ToolProviderName, (typeof toolRows)[number]>();
  for (const r of toolRows) toolByProvider.set(r.provider as ToolProviderName, r);
  const aiByProvider = new Map(aiRows.map((r) => [r.provider as AIProviderName, r]));

  // Polish-25 required trio, called out separately so users see them
  // ranked over the optional/legacy set.
  const REQUIRED_TOOLS: ToolProviderName[] = ['claude', 'gemini'];
  const REQUIRED_AI_PROVIDER: AIProviderName = 'makeugc';
  const OPTIONAL_TOOLS = TOOL_PROVIDERS_ORDER.filter((p) => !REQUIRED_TOOLS.includes(p));
  const OPTIONAL_AI_PROVIDERS = CONNECTABLE_AI_PROVIDERS.filter((p) => p !== REQUIRED_AI_PROVIDER);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-fg-muted mb-3 text-xs font-medium uppercase tracking-wider">
          Required for Polish-25
        </h2>
        <div className="space-y-4">
          {REQUIRED_TOOLS.map((provider) => {
            const meta = TOOL_PROVIDER_META[provider];
            const conn = toolByProvider.get(provider);
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
          <ProviderCard
            provider={REQUIRED_AI_PROVIDER}
            connected={
              aiByProvider.get(REQUIRED_AI_PROVIDER)
                ? {
                    apiKeyVerifiedAt: aiByProvider.get(REQUIRED_AI_PROVIDER)!.apiKeyVerifiedAt,
                    lastVerifiedAt: aiByProvider.get(REQUIRED_AI_PROVIDER)!.lastVerifiedAt,
                    tier: aiByProvider.get(REQUIRED_AI_PROVIDER)!.tier,
                  }
                : null
            }
          />
        </div>
      </section>

      <section>
        <h2 className="text-fg-muted mb-3 text-xs font-medium uppercase tracking-wider">
          Optional providers
        </h2>
        <p className="text-fg-muted mb-4 text-xs">
          Add these only if you want to run alternate pipelines (HeyGen avatars, Hedra Character 3,
          Higgsfield Soul, OpenAI Sora, Replicate hosted models).
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {OPTIONAL_AI_PROVIDERS.map((provider) => {
            const row = aiByProvider.get(provider);
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
          {OPTIONAL_TOOLS.map((provider) => {
            const meta = TOOL_PROVIDER_META[provider];
            const conn = toolByProvider.get(provider);
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
      </section>
    </div>
  );
}

// ---------------------------------------------------------------
// Meta tab: was /connections/meta before Commit 10a. Meta is now
// opt-in — the user only needs it when they hit the launch flow.
// ---------------------------------------------------------------

async function MetaTab({ userId }: { userId: string }) {
  const db = getDb();
  const conn = await db.query.metaConnections.findFirst({
    where: and(eq(schema.metaConnections.userId, userId), isNull(schema.metaConnections.deletedAt)),
    columns: {
      businessManagerId: true,
      adAccountIds: true,
      tokenExpiresAt: true,
      lastVerifiedAt: true,
      accountCurrency: true,
      accountTimezone: true,
      pages: true,
    },
  });

  if (!conn) {
    return (
      <div className="space-y-4">
        <p className="text-fg-muted text-sm">
          Connect your Meta ad account only when you&apos;re ready to launch generated ads. You can
          generate + review videos without connecting Meta.
        </p>
        <DisconnectedNotice
          reconnectHref="/onboarding/agency-bm"
          detail="Paste a long-lived Meta access token to link your Business Manager + ad accounts."
        />
      </div>
    );
  }

  const pageCount = Array.isArray(conn.pages) ? conn.pages.length : 0;
  return (
    <MetaConnectedSummary
      businessManagerId={conn.businessManagerId ?? '(unknown)'}
      adAccountIds={conn.adAccountIds ?? []}
      tokenExpiresAt={conn.tokenExpiresAt ?? null}
      lastVerifiedAt={conn.lastVerifiedAt ?? null}
      accountCurrency={conn.accountCurrency ?? null}
      accountTimezone={conn.accountTimezone ?? null}
      pageCount={pageCount}
    />
  );
}

// ---------------------------------------------------------------
// Telegram tab: was /connections/telegram before Commit 10a.
// ---------------------------------------------------------------

async function TelegramTab({ userId }: { userId: string }) {
  const db = getDb();
  const conn = await db.query.telegramConnections.findFirst({
    where: eq(schema.telegramConnections.userId, userId),
    columns: { tgChatId: true, linkedAt: true, status: true, metadata: true, updatedAt: true },
  });

  if (!conn || conn.status !== 'active' || !conn.tgChatId) {
    return (
      <div className="space-y-4">
        <p className="text-fg-muted text-sm">
          Connect Telegram to receive kill/scale decision pings + daily P&amp;L summaries. Optional
          — Ads Bot works without it.
        </p>
        <DisconnectedNotice
          reconnectHref="/settings"
          detail="Send /start to the Ads Bot Telegram bot from your account to link this app."
        />
      </div>
    );
  }

  const metadata = (conn.metadata ?? {}) as Record<string, unknown>;
  const tgUsername =
    typeof metadata['username'] === 'string' ? (metadata['username'] as string) : null;
  return (
    <TelegramConnectedSummary
      tgChatId={conn.tgChatId}
      tgUsername={tgUsername}
      linkedAt={conn.linkedAt ?? null}
    />
  );
}
