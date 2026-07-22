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
import { MetaTokenPasteForm } from './_meta/token-form';
import { MetaSelectionForm } from './_meta/selection-form';
import { listMetaResources } from './_meta/actions';

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
// Providers tab: Polish-25 required trio was Claude + Gemini +
// MakeUGC pre-Commit-11. Polish-25.2 Commit 11: MakeUGC is now
// platform-managed under the "Instant UGC" brand — no user-facing
// card for it. Required section = Claude + Gemini only. The
// MakeUGC card is hidden from the optional list too, since users
// can't do anything with a personal MakeUGC key (the worker
// resolver prefers MAKEUGC_MANAGED_KEY env).
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

  // Polish-25 required trio → duo (Commit 11 dropped MakeUGC to
  // platform-managed).
  const REQUIRED_TOOLS: ToolProviderName[] = ['claude', 'gemini'];
  const OPTIONAL_TOOLS = TOOL_PROVIDERS_ORDER.filter((p) => !REQUIRED_TOOLS.includes(p));
  // Polish-25.2 Commit 11: filter MakeUGC out of the user-facing
  // optional list too. The row stays in CONNECTABLE_AI_PROVIDERS +
  // the ai_provider enum so any legacy user rows keep working;
  // this UI just hides the card.
  const OPTIONAL_AI_PROVIDERS = CONNECTABLE_AI_PROVIDERS.filter((p) => p !== 'makeugc');

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-fg-muted mb-3 text-xs font-medium uppercase tracking-wider">
          Required
        </h2>
        <p className="text-fg-subtle mb-3 text-xs">
          Instant UGC video generation is included on the platform — no key needed.
        </p>
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
  // Polish-25.2 Commit 13: inline 3-state flow. Restores the paste
  // + selection UI that used to live at /onboarding/meta (deleted
  // in Commit 10a) so users can connect Meta directly from this
  // tab without a redirect to a non-existent onboarding route.
  //
  //   (a) no row                            → MetaTokenPasteForm
  //   (b) row missing BM or ad accounts     → MetaSelectionForm
  //   (c) row with full metadata + status=active → MetaConnectedSummary
  //
  // Polish-25.2 Commit 14: sub-state (b) gate simplified. Was
  // `status === 'pending' && tokenExpiresAt` — but Meta long-lived
  // access tokens report `expires_at = 0` (permanent), so
  // tokenExpiresAt was stored null and the gate fell through to
  // (c), rendering an empty summary. Also handle the corrupted
  // case where status='active' but BM / ad_account_ids never got
  // written — route those back to selection so users can complete
  // setup.
  const db = getDb();
  const conn = await db.query.metaConnections.findFirst({
    where: and(eq(schema.metaConnections.userId, userId), isNull(schema.metaConnections.deletedAt)),
    columns: {
      status: true,
      businessManagerId: true,
      adAccountIds: true,
      tokenExpiresAt: true,
      lastVerifiedAt: true,
      accountCurrency: true,
      accountTimezone: true,
      pages: true,
    },
  });

  // Sub-state (a): no token yet.
  if (!conn) {
    return <MetaTokenPasteForm />;
  }

  // Sub-state (b): token stored but BM + ad account selection not
  // completed. `status === 'pending'` is the canonical "needs
  // selection" signal (set by verifyMetaTokenAction). Also render
  // selection when status='active' but metadata is missing — the
  // partial-write recovery path.
  const missingMetadata =
    !conn.businessManagerId || !Array.isArray(conn.adAccountIds) || conn.adAccountIds.length === 0;
  const needsSelection = conn.status === 'pending' || (conn.status === 'active' && missingMetadata);
  if (needsSelection) {
    const resources = await listMetaResources(userId);
    if ('error' in resources) {
      return (
        <div className="border-[color:var(--accent-negative)]/50 bg-[color:var(--accent-negative)]/5 space-y-2 rounded-md border p-4 text-sm">
          <p className="text-fg font-semibold">
            Couldn&apos;t list your Business Managers + ad accounts.
          </p>
          <p className="text-fg-muted text-xs">{resources.error}</p>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {conn.status === 'active' && missingMetadata && (
          <div className="border-[color:var(--accent-warning)]/40 bg-[color:var(--accent-warning)]/5 text-fg-muted rounded-md border p-3 text-xs">
            Meta token is on file, but the Business Manager + ad account selection isn&apos;t
            complete. Pick them below to finish the connection.
          </div>
        )}
        <MetaSelectionForm businesses={resources.businesses} adAccounts={resources.adAccounts} />
      </div>
    );
  }

  // Sub-state (c): fully connected.
  const pageCount = Array.isArray(conn.pages) ? conn.pages.length : 0;
  return (
    <div className="space-y-4">
      <MetaConnectedSummary
        businessManagerId={conn.businessManagerId ?? '(unknown)'}
        adAccountIds={conn.adAccountIds ?? []}
        tokenExpiresAt={conn.tokenExpiresAt ?? null}
        lastVerifiedAt={conn.lastVerifiedAt ?? null}
        accountCurrency={conn.accountCurrency ?? null}
        accountTimezone={conn.accountTimezone ?? null}
        pageCount={pageCount}
      />
      {/* Polish-25.2 Commit 16b: point operators at the automation
          rules explainer right after they connect Meta — the first
          question every new operator asks is "what will the bot
          do automatically?". Answer that inline before they
          launch. */}
      <div className="border-border-subtle bg-bg-surface rounded-md border p-4 text-sm">
        <p className="text-fg font-medium">Before your first live launch</p>
        <p className="text-fg-muted mt-1 text-xs leading-relaxed">
          The bot auto-pauses (kills) ads that spend without converting and auto-scales winners.
          Review the thresholds so nothing surprises you the first time an ad hits the kill rule.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href="/settings/rules"
            className="border-fg/30 hover:bg-bg-surfaceHover inline-flex items-center rounded-sm border px-2.5 py-1 text-xs font-medium"
          >
            Review automation rules
          </Link>
          <Link
            href="/settings/presets"
            className="border-fg/30 hover:bg-bg-surfaceHover inline-flex items-center rounded-sm border px-2.5 py-1 text-xs font-medium"
          >
            Set up launch presets
          </Link>
        </div>
      </div>
    </div>
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
