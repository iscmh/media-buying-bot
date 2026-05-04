/**
 * cascadePauseUser:
 *  - sets users.is_paused = true
 *  - inserts a user_pause_log row with reason + paused_by
 *  - audit log entry written
 *  - idempotent: a second call while still paused inserts another log row
 *    (so reason history is preserved across multiple disconnect events)
 *
 * Skip-if-unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { cascadePauseUser, closeDb, getDb, getLatestPauseReason, schema } from '../src';

const skip = !process.env.TEST_DATABASE_URL;

describe.skipIf(skip)('cascadePauseUser', () => {
  let admin: postgres.Sql;
  let userId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL && process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    }
    admin = postgres(process.env.TEST_DATABASE_URL!, { prepare: false });
    const [row] = await admin<{ id: string }[]>`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (gen_random_uuid(), 'cascade-pause-test@local.test',
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

  it('flips users.is_paused to true and writes a pause log row', async () => {
    await cascadePauseUser({
      userId,
      reason: 'meta_disconnected',
      pausedBy: 'auto',
    });

    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { isPaused: true },
    });
    expect(user?.isPaused).toBe(true);

    const log = await getLatestPauseReason(userId);
    expect(log?.reason).toBe('meta_disconnected');
    expect(log?.pausedBy).toBe('auto');
  });

  it('inserts a second pause log row when called again while still paused', async () => {
    // User is still paused from the previous test. Cascade-pause again
    // with a different reason — we want both rows to exist so the audit
    // shows the order.
    await cascadePauseUser({
      userId,
      reason: 'ai_provider_disconnected',
      pausedBy: 'auto',
    });

    const db = getDb();
    const openLogs = await db.query.userPauseLog.findMany({
      where: and(eq(schema.userPauseLog.userId, userId), isNull(schema.userPauseLog.unpausedAt)),
    });
    // Phase 2c will close out earlier ones on unpause; for now both rows
    // are open. We expect at least 2 reasons in the unresolved set.
    const reasons = openLogs.map((r) => r.reason).sort();
    expect(reasons).toContain('meta_disconnected');
    expect(reasons).toContain('ai_provider_disconnected');

    // getLatestPauseReason returns the most recent.
    const latest = await getLatestPauseReason(userId);
    expect(latest?.reason).toBe('ai_provider_disconnected');
  });
});
