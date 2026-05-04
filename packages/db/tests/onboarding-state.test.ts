/**
 * Onboarding state derivation:
 *   - Fresh user → nextStep = 'tos', everything incomplete.
 *   - tos_accepted_at + matching version → tos complete, nextStep = 'risk'.
 *   - Stale tos_version → tos still incomplete (forced re-acceptance).
 *   - audit_log risk_education_acknowledged → risk complete.
 *   - meta_connections active → meta complete.
 *   - telegram_connections active → telegram complete.
 *   - All four → nextStep = null.
 *
 * Skip-if-unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { TOS_VERSION } from '@mbb/shared';
import { closeDb, getDb, getOnboardingState, schema } from '../src';
import { eq } from 'drizzle-orm';

const skip = !process.env.TEST_DATABASE_URL;

describe.skipIf(skip)('Onboarding state derivation', () => {
  let admin: postgres.Sql;
  let userId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL && process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    }
    admin = postgres(process.env.TEST_DATABASE_URL!, { prepare: false });
    const [row] = await admin<{ id: string }[]>`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (gen_random_uuid(), 'onboarding-state-test@local.test',
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

  it('fresh user → nextStep is "tos", everything incomplete', async () => {
    const state = await getOnboardingState(userId);
    expect(state.nextStep).toBe('tos');
    expect(state.completed).toEqual({
      tos: false,
      risk: false,
      meta: false,
      telegram: false,
    });
  });

  it('current TOS_VERSION acceptance → tos done, nextStep "risk"', async () => {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ tosAcceptedAt: new Date(), tosVersion: TOS_VERSION })
      .where(eq(schema.users.id, userId));
    const state = await getOnboardingState(userId);
    expect(state.completed.tos).toBe(true);
    expect(state.nextStep).toBe('risk');
  });

  it('stale tos_version forces re-acceptance', async () => {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ tosAcceptedAt: new Date(), tosVersion: 'v0-stale' })
      .where(eq(schema.users.id, userId));
    const state = await getOnboardingState(userId);
    expect(state.completed.tos).toBe(false);
    expect(state.nextStep).toBe('tos');
  });

  it('all four steps complete → nextStep is null', async () => {
    const db = getDb();
    // tos
    await db
      .update(schema.users)
      .set({ tosAcceptedAt: new Date(), tosVersion: TOS_VERSION })
      .where(eq(schema.users.id, userId));
    // risk
    await db.insert(schema.auditLogs).values({
      userId,
      eventType: 'risk_education_acknowledged',
      eventData: { test: true },
    });
    // meta
    await db.insert(schema.metaConnections).values({
      userId,
      status: 'active',
      connectionMethod: 'byok',
      businessManagerId: 'bm_test',
      adAccountIds: ['act_test'],
    });
    // telegram
    await db.insert(schema.telegramConnections).values({
      userId,
      status: 'active',
      tgChatId: 'chat_test',
      linkedAt: new Date(),
    });

    const state = await getOnboardingState(userId);
    expect(state.completed).toEqual({
      tos: true,
      risk: true,
      meta: true,
      telegram: true,
    });
    expect(state.nextStep).toBeNull();
  });
});
