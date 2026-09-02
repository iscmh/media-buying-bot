/**
 * Drizzle schema entry. Re-exports every table so consumers do
 * `import { users, ads } from '@mbb/db/schema'`.
 *
 * RLS policies and Vault setup are NOT defined here — those live in
 * supabase/migrations/*.sql since they're Postgres-native features.
 */
export * from './enums';
export * from './users';
export * from './connections';
export * from './settings';
export * from './concepts';
export * from './generation';
export * from './ads';
export * from './launched-ads';
export * from './meta-pages';
export * from './pending-approvals';
export * from './beta-access';
export * from './whop';
export * from './performance';
export * from './logs';
export * from './ops';
export * from './partners';
export * from './makeugc-avatar-index';
export * from './user-launch-presets';
export * from './error-log';
export * from './api-keys';
export * from './api-request-log';
export * from './heygen-avatar-index';
export * from './credits';
