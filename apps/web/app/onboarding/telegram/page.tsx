import { eq } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { requireOnboardingStep } from '@/lib/onboarding-gate';
import { generateTelegramLinkCode } from './actions';
import { TelegramLinkClient } from './telegram-client';

export const metadata = { title: 'Link Telegram' };

export default async function OnboardingTelegramPage() {
  const { userId } = await requireOnboardingStep('telegram');

  const db = getDb();
  const existing = await db.query.telegramConnections.findFirst({
    where: eq(schema.telegramConnections.userId, userId),
    columns: { linkCode: true, linkCodeGeneratedAt: true, status: true },
  });

  let code: string;
  // Reuse a pending code if it's still fresh (< 14 minutes); otherwise rotate.
  // 14 not 15 so a freshly-rendered page never has < 1 minute left.
  const FOURTEEN_MIN = 14 * 60 * 1000;
  if (
    existing?.status === 'pending' &&
    existing.linkCode &&
    existing.linkCodeGeneratedAt &&
    Date.now() - existing.linkCodeGeneratedAt.getTime() < FOURTEEN_MIN
  ) {
    code = existing.linkCode;
  } else {
    const generated = await generateTelegramLinkCode();
    code = generated.code;
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'YourBot_bot';

  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Link Telegram</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          One-time code, expires in 15 minutes. Send it to the bot from your Telegram app.
        </p>
      </header>

      <TelegramLinkClient code={code} botUsername={botUsername} />
    </article>
  );
}
