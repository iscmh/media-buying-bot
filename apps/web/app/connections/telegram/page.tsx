import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { formatDate } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { TelegramConnectedSummary } from './connected-summary';

export const metadata = { title: 'Telegram bot — Media Buying Bot' };

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
      <main className="container mx-auto max-w-2xl px-4 py-12">
        <h1 className="mb-2 text-3xl font-bold">Telegram</h1>
        <p className="text-destructive text-sm">
          Disconnected
          {conn?.updatedAt && <> · last linked {formatDate(conn.updatedAt)}</>}.{' '}
          <Link href="/onboarding/telegram" className="underline">
            Reconnect →
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Telegram</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Where the bot pings you for kill/scale decisions and daily summaries.
        </p>
      </header>

      <TelegramConnectedSummary
        tgChatId={conn.tgChatId}
        tgUsername={conn.metadata?.tgUsername ?? null}
        linkedAt={conn.linkedAt}
      />
    </main>
  );
}
