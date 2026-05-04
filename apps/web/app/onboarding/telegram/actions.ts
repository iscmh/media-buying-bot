'use server';

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * Generate (or rotate) a one-time Telegram link code.
 *
 *  - 16 bytes → 32 hex chars → 128 bits entropy.
 *  - Stored on telegram_connections.link_code, link_code_generated_at = now().
 *  - If the user already has a row, we overwrite the code and reset status
 *    to 'pending'. Any earlier code is implicitly invalidated.
 *  - If status is already 'active' we throw — the page guard prevents this
 *    path; the throw is defensive.
 *
 * Redemption (the matching update) lives in @mbb/db/redeemTelegramLinkCode
 * so the bot can import it directly.
 */
export async function generateTelegramLinkCode(): Promise<{ code: string }> {
  const user = await requireUser();
  const db = getDb();

  const existing = await db.query.telegramConnections.findFirst({
    where: eq(schema.telegramConnections.userId, user.id),
    columns: { id: true, status: true },
  });

  if (existing?.status === 'active') {
    throw new Error('Telegram is already linked.');
  }

  const code = randomBytes(16).toString('hex');
  const now = new Date();

  if (existing) {
    await db
      .update(schema.telegramConnections)
      .set({
        linkCode: code,
        linkCodeGeneratedAt: now,
        status: 'pending',
        tgChatId: null,
        linkedAt: null,
      })
      .where(eq(schema.telegramConnections.id, existing.id));
  } else {
    await db.insert(schema.telegramConnections).values({
      userId: user.id,
      linkCode: code,
      linkCodeGeneratedAt: now,
      status: 'pending',
    });
  }

  await logAuditEvent({
    userId: user.id,
    eventType: 'telegram_link_code_generated',
    eventData: { code_prefix: code.slice(0, 6), generated_at: now.toISOString() },
  });

  return { code };
}

/** Polled by the client every 3s to detect when the bot has redeemed. */
export async function getTelegramLinkStatus(): Promise<{
  status: 'pending' | 'active' | 'none';
}> {
  const user = await requireUser();
  const db = getDb();

  const row = await db.query.telegramConnections.findFirst({
    where: eq(schema.telegramConnections.userId, user.id),
    columns: { status: true },
  });

  if (!row) return { status: 'none' };
  if (row.status === 'active') return { status: 'active' };
  return { status: 'pending' };
}
