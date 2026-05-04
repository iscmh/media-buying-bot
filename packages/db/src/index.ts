export * as schema from './schema/index';
export { getDb, closeDb } from './client';
export { logAuditEvent } from './audit';
export { logMetaApiCall } from './meta-api-log';
export { checkSpendSafety } from './safety/spend-safety';
export { checkKillSwitches } from './safety/kill-switches';
export { isFeatureEnabled } from './safety/feature-flags';
export { reserveRateLimitSlot, recordRateLimitHit } from './safety/rate-limiter';
export { encryptSecret, decryptSecret } from './safety/encryption';
