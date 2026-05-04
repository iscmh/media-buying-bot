/**
 * Multi-tenant isolation: User A literally cannot read User B's data.
 *
 * This is the most important test in the entire codebase. If RLS breaks,
 * customers see each other's ad accounts, tokens, performance — that is
 * a business-ending bug.
 *
 * Requires a running Postgres with all migrations applied + at least one
 * authenticated test JWT per user. We use Supabase's local instance.
 *
 * Skip-if-unavailable: if TEST_DATABASE_URL is unset, the test is skipped
 * with a warning. CI sets it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const TEST_URL = process.env.TEST_DATABASE_URL;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const skip = !TEST_URL || !SUPABASE_URL || !SUPABASE_ANON;

describe.skipIf(skip)('multi-tenant isolation', () => {
  let admin: postgres.Sql;

  beforeAll(() => {
    admin = postgres(TEST_URL!, { prepare: false });
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('User A cannot SELECT User B concept rows under RLS', async () => {
    // Seed two users + one concept each, via the admin (service-role bypass) connection.
    const userA = await createTestUser(admin, 'a@test.local');
    const userB = await createTestUser(admin, 'b@test.local');

    await admin`
      insert into public.concepts (user_id, content_type, description)
      values (${userA}, 'text', 'A-only concept'),
             (${userB}, 'text', 'B-only concept')
    `;

    // Now connect as User A using the auth-scoped JWT and try to read everything.
    const aClient = await createAuthedClient(userA);
    try {
      const rows = await aClient`select user_id, description from public.concepts`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.user_id).toBe(userA);
      expect(rows[0]!.description).toBe('A-only concept');
    } finally {
      await aClient.end();
    }
  });

  it('User A cannot UPDATE User B rows', async () => {
    const userA = await createTestUser(admin, 'a2@test.local');
    const userB = await createTestUser(admin, 'b2@test.local');

    const [bConcept] = await admin<{ id: string }[]>`
      insert into public.concepts (user_id, content_type, description)
      values (${userB}, 'text', 'B owns this')
      returning id
    `;

    const aClient = await createAuthedClient(userA);
    try {
      const result = await aClient`
        update public.concepts set description = 'hijacked' where id = ${bConcept!.id}
      `;
      // RLS UPDATE without permission affects 0 rows (Postgres semantics).
      expect(result.count).toBe(0);
    } finally {
      await aClient.end();
    }

    const [check] = await admin<{ description: string }[]>`
      select description from public.concepts where id = ${bConcept!.id}
    `;
    expect(check!.description).toBe('B owns this');
  });
});

async function createTestUser(admin: postgres.Sql, email: string): Promise<string> {
  // The auth.users insert triggers the public.users + user_settings creation.
  const [row] = await admin<{ id: string }[]>`
    insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
    values (gen_random_uuid(), ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)
    returning id
  `;
  return row!.id;
}

async function createAuthedClient(_userId: string): Promise<postgres.Sql> {
  // For Phase 1 we approximate the RLS-scoped session by setting
  // request.jwt.claims via SET LOCAL. Real tests in CI will mint a proper
  // JWT with the supabase secret and use the gotrue-issued JWT through
  // PostgREST. Both approaches verify the same `auth.uid()` behavior.
  const sql = postgres(TEST_URL!, { prepare: false });
  await sql`select set_config('role', 'authenticated', false)`;
  await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: _userId })}, false)`;
  return sql;
}
