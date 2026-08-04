import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Polish-25.10 Commit 59: mirror of supabase/migrations/0043_api_keys.sql.
 *
 * Bearer tokens for /api/v1/*. Plaintext returned to the operator
 * exactly once at create; we store SHA-256(key) so a DB dump can't
 * impersonate anyone. See packages/db/src/api-keys.ts for
 * generate/hash/verify helpers.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: text('key_prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('api_keys_user_id_idx').on(t.userId),
    keyHashIdx: index('api_keys_key_hash_idx').on(t.keyHash),
  }),
);
