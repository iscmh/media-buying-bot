import { eq } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { formatDate } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { DisconnectedNotice } from '../_shared/disconnected-notice';
import { TelegramConnectedSummary } from './connected-summary';

export const metadata = { title: 'Telegram bot' };

export default async function ConnectTelegramPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();
  const conn = await db.query.telegramConnections.findFirst({
    where: eq(schema.telegramConnections.userId, userId),
    columns: { tgChatId: true, linkedAt: true, status: true, metadata: true, updatedAt: true },
  });

  // Defensive — the gate should have redirected us before reaching this
  // branch. If we land here anyway (race during disconnect), surface a
  // "Disconnected · Reconnect →" line rather than an empty state.
  if (!conn || conn.status !== 'active' || !conn.tgChatId) {
    return (
      <AppShell crumbs={[{ label: 'Connections' }, { label: 'Telegram' }]} contentClass="max-w-2xl">
        <header className="mb-6">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">Telegram</h1>
          <p className="text-fg-muted mt-1 text-sm">
            Where the bot pings you for kill/scale decisions and daily summaries.
          </p>
        </header>
        <DisconnectedNotice
          reconnectHref="/onboarding/telegram"
          detail={conn?.updatedAt ? `Last linked ${formatDate(conn.updatedAt)}` : null}
        />
      </AppShell>
    );
  }

  return (
    <AppShell crumbs={[{ label: 'Connections' }, { label: 'Telegram' }]} contentClass="max-w-2xl">
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Telegram</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Where the bot pings you for kill/scale decisions and daily summaries.
        </p>
      </header>

      <TelegramConnectedSummary
        tgChatId={conn.tgChatId}
        tgUsername={conn.metadata?.tgUsername ?? null}
        linkedAt={conn.linkedAt}
      />
    </AppShell>
  );
}
