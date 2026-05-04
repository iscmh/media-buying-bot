export * as schema from './schema/index';
export { getDb, closeDb } from './client';
export { logAuditEvent } from './audit';
export { logMetaApiCall } from './meta-api-log';
export { checkSpendSafety } from './safety/spend-safety';
export { checkKillSwitches } from './safety/kill-switches';
export { isFeatureEnabled } from './safety/feature-flags';
export { reserveRateLimitSlot, recordRateLimitHit } from './safety/rate-limiter';
export { encryptSecret, decryptSecret } from './safety/encryption';
export { getOnboardingState, type OnboardingState } from './onboarding';
export {
  redeemTelegramLinkCode,
  getActiveLinkByChatId,
  LINK_CODE_TTL_MINUTES,
  type RedeemResult,
  type RedeemFailureReason,
} from './telegram-link';
export {
  getUserSettings,
  saveUserSettings,
  diffSettings,
  type SettingsRow,
  type SettingsChange,
} from './settings';
export { cascadePauseUser, getLatestPauseReason } from './pause';
