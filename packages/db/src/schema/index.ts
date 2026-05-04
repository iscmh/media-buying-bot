/**
 * Drizzle schema entry. Re-exports every table so consumers do
 * `import { users, ads } from '@mbb/db/schema'`.
 *
 * RLS policies and Vault setup are NOT defined here — those live in
 * supabase/migrations/*.sql since they're Postgres-native features.
 */
export * from './enums.js';
export * from './users.js';
export * from './connections.js';
export * from './settings.js';
export * from './concepts.js';
export * from './generation.js';
export * from './ads.js';
export * from './performance.js';
export * from './logs.js';
export * from './ops.js';
export * from './partners.js';
