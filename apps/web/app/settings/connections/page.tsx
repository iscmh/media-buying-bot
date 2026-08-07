import Link from 'next/link';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, getTelegramPreferences, schema } from '@mbb/db';
import {
  CONNECTABLE_AI_PROVIDERS,
  TOOL_PROVIDERS_ORDER,
  TOOL_PROVIDER_META,
  type AIProviderName,
  type ToolProviderName,
} from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { BetaBanner } from '@/components/shell/beta-banner';
import { PageHeader } from '@/components/shell/page-header';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ProviderCard } from '@/app/connections/ai-provider/provider-card';
import { ToolCard } from '@/app/connections/tools/tool-card';
import { MetaConnectedSummary } from '@/app/connections/meta/connected-summary';
import { MetaTokenPasteForm } from './_meta/token-form';
import { MetaSelectionForm } from './_meta/selection-form';
import { listMetaResources } from './_meta/actions';
import { TelegramPanel } from './_telegram/telegram-panel';

export const metadata = { title: 'Connections' };
export const dynamic = 'force-dynamic';

type Tab = 'providers' | 'meta' | 'telegram';
const VALID_TABS: readonly Tab[] = ['providers', 'meta', 'telegram'];

interface Props {
  searchParams: Promise<{ tab?: string }>;
}

/**
 * Polish-25.6 Commit 34: Telegram tab REMOVED for MVP.
 *
 * WHY: the pre-Commit-34 Telegram tab surfaced a disconnected notice
 * with no working Connect button — no bot username link, no deep
 * link, `reconnectHref="/settings"` was a dead redirect. Kill/scale
 * automation copy in Settings + Rules + AutomationAcks referenced
 * Telegram as the approval channel, which meant users acked those
 * rules and then had no way to approve fired recommendations. The
 * launch-blocker audit (Commit 33) called this out as bug 1.1.
 *
 * Fix for MVP: deprecate Telegram entirely. Approve/reject fires via
 * inline buttons on /launched (Commit 34 also adds those). Legacy
 * telegram_connections rows are left in-place — nothing hard-deletes
 * them, they just don't render anywhere. Telegram will be re-added
 * post-launch with a real Connect flow.
 *
 * Also Polish-25.6 Commit 34: "Optional providers" section is
 * collapsed behind a `<details>` disclosure so a fresh user only
 * sees the two Required providers (Claude + Gemini) unless they
 * explicitly opt in to see the alternate pipelines. Audit called
 * this out as launch-blocker item 5 — five unfamiliar brand names
 * on the primary connections surface read as "half-baked plumbing."
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
        subtitle="AI providers and your Meta ad account, all in one place."
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
      {tab === 'meta' && (
        <>
          <BetaBanner />
          <MetaTab userId={userId} />
        </>
      )}
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

  const REQUIRED_TOOLS: ToolProviderName[] = ['claude', 'gemini'];
  // Polish-28.0.0 Commit 64: ElevenLabs + HeyGen unhidden — required
  // BYOK for the Polish-28 cloned-UGC pipeline (ElevenLabs Instant
  // Voice Clone + HeyGen Avatar IV image-to-video). Kept hidden from
  // the Commit-63 blocklist: hedra / wavespeed_ai / makeugc /
  // replicate / kie_ai — those pipelines remain nuked and their DB
  // rows are preserved for rollback.
  const HIDDEN_LEGACY_AI_PROVIDERS = new Set<AIProviderName>([
    'hedra',
    'wavespeed_ai',
    'makeugc',
    'replicate',
  ]);
  const HIDDEN_LEGACY_TOOL_PROVIDERS = new Set<ToolProviderName>(['kie_ai']);
  const OPTIONAL_TOOLS = TOOL_PROVIDERS_ORDER.filter(
    (p) => !REQUIRED_TOOLS.includes(p) && !HIDDEN_LEGACY_TOOL_PROVIDERS.has(p),
  );
  const OPTIONAL_AI_PROVIDERS = CONNECTABLE_AI_PROVIDERS.filter(
    (p) => !HIDDEN_LEGACY_AI_PROVIDERS.has(p),
  );

  // Count how many optional providers the user has already connected —
  // if any, expand the disclosure by default so they can see + manage them.
  const connectedOptionalCount =
    OPTIONAL_TOOLS.filter((p) => toolByProvider.get(p)?.status === 'active').length +
    OPTIONAL_AI_PROVIDERS.filter((p) => aiByProvider.get(p)).length;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-fg-muted mb-3 text-xs font-medium uppercase tracking-wider">
          Required
        </h2>
        <p className="text-fg-subtle mb-3 text-xs">
          {/* Polish-27.0.0 Commit 63: Instant UGC line removed; the
              managed backend is being rebuilt in Polish-28. */}
          Claude + Gemini power ad-spec generation, source-video analysis, and Static ad copy
          rewrites.
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
        <details open={connectedOptionalCount > 0} className="group">
          <summary className="text-fg-muted hover:text-fg flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium uppercase tracking-wider group-open:mb-4">
            <span>
              Alternate pipelines{' '}
              <span className="text-fg-subtle normal-case tracking-normal">
                (optional, only if you want to run a specific model)
              </span>
            </span>
            <span
              aria-hidden
              className="text-fg-subtle text-[10px] transition-transform group-open:rotate-90"
            >
              ▶
            </span>
          </summary>
          <p className="text-fg-muted mb-4 text-xs">
            {/* Polish-28.0.0 Commit 64: ElevenLabs + HeyGen unhidden —
                required BYOK for Instant UGC (Cloned). */}
            Optional provider keys for the pipelines available today. Connect ElevenLabs + HeyGen to
            unlock Instant UGC (Cloned); OpenAI powers Static ad.
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
        </details>
      </section>
    </div>
  );
}

async function MetaTab({ userId }: { userId: string }) {
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

  if (!conn) {
    return <MetaTokenPasteForm />;
  }

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

/**
 * Polish-25.8 Commit 47: Telegram tab restored. Renders TelegramPanel
 * (client component) with the current connection state so the
 * generate-link-code + disconnect flows have server-fetched data.
 */
async function TelegramTab({ userId }: { userId: string }) {
  const db = getDb();
  const [conn, preferences] = await Promise.all([
    db.query.telegramConnections.findFirst({
      where: eq(schema.telegramConnections.userId, userId),
      columns: { status: true, tgChatId: true, linkedAt: true, metadata: true },
    }),
    getTelegramPreferences(userId),
  ]);
  const connected = conn?.status === 'active' && !!conn.tgChatId;
  const meta = conn?.metadata as { tgUsername?: string } | null;
  return (
    <TelegramPanel
      connected={connected}
      tgUsername={meta?.tgUsername ?? null}
      linkedAtIso={conn?.linkedAt?.toISOString() ?? null}
      botUsername={process.env['NEXT_PUBLIC_TELEGRAM_BOT_USERNAME'] ?? null}
      preferences={preferences}
    />
  );
}
