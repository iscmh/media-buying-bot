import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

/**
 * Drizzle client for server-side, privileged access (jobs, internal APIs).
 *
 * IMPORTANT: this connection bypasses RLS. Only use from trusted server code
 * that has already verified the request is allowed. For user-scoped reads/
 * writes from the web app, use the Supabase client (with the user's JWT) so
 * RLS policies enforce isolation.
 */

let _client: postgres.Sql | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for direct DB access. See .env.example.');
  }

  _client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    prepare: false, // Supabase pgbouncer doesn't support prepared statements in transaction mode.
  });
  _db = drizzle(_client, { schema });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

export type Db = ReturnType<typeof getDb>;
