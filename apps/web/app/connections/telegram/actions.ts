'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cascadePauseUser, getDb, logAuditEvent, schema } from '@mbb/db';
import { sendBotMessage } from '@/lib/telegram/bot-api';
import { getSupabaseServerClient } from '@/lib/supabase/server';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

const FAREWELL_MESSAGE =
  "You've disconnected this Telegram from Media Buying Bot. " +
  "You won't receive alerts here anymore. Re-link in the web app to reconnect.";

/**
 * Disconnect Telegram. Order:
 *
 *   1. Read tg_chat_id (we need it for the farewell DM BEFORE clearing it).
 *   2. Send the farewell DM via direct Bot API (best-effort, logged).
 *   3. Clear tg_chat_id, set status='revoked', null linked_at.
 *   4. Cascade-pause the user (matches Meta + AI provider disconnect).
 *   5. Audit log telegram_disconnected with farewell-DM result.
 *   6. Redirect to /settings/connections?tab=telegram so the page renders the link-code
 *      flow again on reconnect.
 *
 * The farewell DM is a courtesy; if it fails, the local cleanup still
 * happens. Most common failure: user blocked the bot.
 */
export async function disconnectTelegramAction(): Promise<void> {
  const user = await requireUser();
  const db = getDb();

  const conn = await db.query.telegramConnections.findFirst({
    where: eq(schema.telegramConnections.userId, user.id),
    columns: { id: true, tgChatId: true, status: true },
  });
  if (!conn) {
    redirect('/settings/connections?tab=telegram');
  }

  let farewellOk = false;
  let farewellDescription: string | undefined;
  if (conn.tgChatId && conn.status === 'active') {
    const result = await sendBotMessage({ chatId: conn.tgChatId, text: FAREWELL_MESSAGE });
    farewellOk = result.ok;
    farewellDescription = result.description;
  }

  await db
    .update(schema.telegramConnections)
    .set({
      tgChatId: null,
      linkedAt: null,
      status: 'revoked',
      linkCode: null,
      linkCodeGeneratedAt: null,
      metadata: null,
    })
    .where(eq(schema.telegramConnections.id, conn.id));

  await cascadePauseUser({
    userId: user.id,
    reason: 'telegram_disconnected',
    pausedBy: 'auto',
  });

  await logAuditEvent({
    userId: user.id,
    eventType: 'telegram_disconnected',
    eventData: {
      farewell_dm_attempted: !!conn.tgChatId,
      farewell_dm_ok: farewellOk,
      farewell_dm_error: farewellDescription ?? null,
    },
  });

  revalidatePath('/connections/telegram');
  redirect('/settings/connections?tab=telegram');
}
