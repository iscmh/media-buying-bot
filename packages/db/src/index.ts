export * as schema from './schema/index.js';
export { getDb, closeDb } from './client.js';
export { logAuditEvent } from './audit.js';
export { logMetaApiCall } from './meta-api-log.js';
export { checkSpendSafety } from './safety/spend-safety.js';
export { checkKillSwitches } from './safety/kill-switches.js';
export { isFeatureEnabled } from './safety/feature-flags.js';
export { reserveRateLimitSlot, recordRateLimitHit } from './safety/rate-limiter.js';
export { encryptSecret, decryptSecret } from './safety/encryption.js';
