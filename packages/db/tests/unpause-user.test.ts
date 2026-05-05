/**
 * unpauseUser:
 *  - flips users.is_paused = false
 *  - closes ALL open user_pause_log rows (sets unpaused_at = now())
 *  - audit-logs `user_unpaused` with previous_pause_count + previous_reasons
 *  - is a no-op (returns null, writes no audit log) if user wasn't paused
 *
 * Skip-if-unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { cascadePauseUser, closeDb, getDb, schema, unpauseUser } from '../src';

const skip = !process.env.TEST_DATABASE_URL;

describe.skipIf(skip)('unpauseUser', () => {
  let admin: postgres.Sql;
  let userId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL && process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    }
    admin = postgres(process.env.TEST_DATABASE_URL!, { prepare: false });
    const [row] = await admin<{ id: string }[]>`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (gen_random_uuid(), 'unpause-test@local.test',
              '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)
      returning id`;
    userId = row!.id;
  });

  afterAll(async () => {
    if (admin && userId) {
      await admin`delete from auth.users where id = ${userId}`;
    }
    await admin?.end();
    await closeDb();
  });

  it('closes a single open pause-log row', async () => {
    await cascadePauseUser({ userId, reason: 'meta_disconnected', pausedBy: 'auto' });

    const result = await unpauseUser(userId);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.previousPauseCount).toBe(1);
    expect(result.previousReasons).toEqual(['meta_disconnected']);

    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { isPaused: true },
    });
    expect(user?.isPaused).toBe(false);

    const stillOpen = await db.query.userPauseLog.findMany({
      where: and(eq(schema.userPauseLog.userId, userId), isNull(schema.userPauseLog.unpausedAt)),
    });
    expect(stillOpen).toHaveLength(0);
  });

  it('closes ALL open log rows when multiple pauses stacked up', async () => {
    // Stack three pause events without unpausing in between.
    await cascadePauseUser({ userId, reason: 'meta_disconnected', pausedBy: 'auto' });
    await cascadePauseUser({ userId, reason: 'telegram_disconnected', pausedBy: 'auto' });
    await cascadePauseUser({ userId, reason: 'ai_provider_disconnected', pausedBy: 'auto' });

    const result = await unpauseUser(userId);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.previousPauseCount).toBe(3);
    expect(result.previousReasons.sort()).toEqual([
      'ai_provider_disconnected',
      'meta_disconnected',
      'telegram_disconnected',
    ]);

    const db = getDb();
    const stillOpen = await db.query.userPauseLog.findMany({
      where: and(eq(schema.userPauseLog.userId, userId), isNull(schema.userPauseLog.unpausedAt)),
    });
    expect(stillOpen).toHaveLength(0);
  });

  it('is a no-op when the user is not paused', async () => {
    // After the previous test the user is unpaused with no open log rows.
    const result = await unpauseUser(userId);
    expect(result).toBeNull();

    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { isPaused: true },
    });
    expect(user?.isPaused).toBe(false);
  });
});
