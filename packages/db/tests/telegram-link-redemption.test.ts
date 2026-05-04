/**
 * Telegram link code redemption rules:
 *   - valid + unexpired pending code → ok, status=active, code cleared
 *   - already-redeemed code → fails as invalid_or_used
 *   - >15 minutes old code → fails as expired
 *   - unknown code → fails as invalid_or_used
 *
 * Skip-if-unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { closeDb, getDb, redeemTelegramLinkCode, schema, LINK_CODE_TTL_MINUTES } from '../src';

const skip = !process.env.TEST_DATABASE_URL;

describe.skipIf(skip)('Telegram link redemption', () => {
  let admin: postgres.Sql;
  let testUserId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL && process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    }
    admin = postgres(process.env.TEST_DATABASE_URL!, { prepare: false });
    const [row] = await admin<{ id: string }[]>`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (gen_random_uuid(), 'tg-redeem-test@local.test',
              '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)
      returning id`;
    testUserId = row!.id;
  });

  afterAll(async () => {
    if (admin && testUserId) {
      await admin`delete from auth.users where id = ${testUserId}`;
    }
    await admin?.end();
    await closeDb();
  });

  async function seedCode(code: string, generatedAt: Date) {
    const db = getDb();
    await db
      .insert(schema.telegramConnections)
      .values({
        userId: testUserId,
        linkCode: code,
        linkCodeGeneratedAt: generatedAt,
        status: 'pending',
      })
      .onConflictDoUpdate({
        target: schema.telegramConnections.userId,
        set: {
          linkCode: code,
          linkCodeGeneratedAt: generatedAt,
          status: 'pending',
          tgChatId: null,
          linkedAt: null,
        },
      });
  }

  it('redeems a fresh pending code', async () => {
    const code = 'aaaa1111bbbb2222cccc3333dddd4444';
    await seedCode(code, new Date());

    const result = await redeemTelegramLinkCode({
      code,
      tgChatId: '111222333',
      tgUsername: 'testuser',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(testUserId);

    // Confirm DB state.
    const db = getDb();
    const row = await db.query.telegramConnections.findFirst({
      where: eq(schema.telegramConnections.userId, testUserId),
    });
    expect(row?.status).toBe('active');
    expect(row?.linkCode).toBeNull();
    expect(row?.linkCodeGeneratedAt).toBeNull();
    expect(row?.tgChatId).toBe('111222333');
  });

  it('rejects an already-used code', async () => {
    const code = 'eeee5555ffff6666eeee5555ffff6666';
    await seedCode(code, new Date());
    const first = await redeemTelegramLinkCode({ code, tgChatId: '999' });
    expect(first.ok).toBe(true);

    const second = await redeemTelegramLinkCode({ code, tgChatId: '888' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('invalid_or_used');
  });

  it('rejects an expired code', async () => {
    const code = 'expr0000expr0000expr0000expr0000';
    const past = new Date(Date.now() - (LINK_CODE_TTL_MINUTES + 1) * 60 * 1000);
    await seedCode(code, past);

    const result = await redeemTelegramLinkCode({ code, tgChatId: '777' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('expired');
  });

  it('rejects an unknown code', async () => {
    const result = await redeemTelegramLinkCode({
      code: 'unknown_unknown_unknown_unknown__',
      tgChatId: '666',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_or_used');
  });
});
