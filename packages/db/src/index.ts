export * as schema from './schema/index';
export { getDb, closeDb } from './client';
export { logAuditEvent } from './audit';
export { logMetaApiCall } from './meta-api-log';
export { logAiProviderApiCall } from './ai-provider-log';
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
export { cascadePauseUser, getLatestPauseReason, isMetaConnected, unpauseUser } from './pause';
export {
  getTelegramUserByChatId,
  listTelegramUsers,
  getTelegramPreferences,
  updateTelegramPreferences,
  isInQuietHours,
  isDailySummaryHour,
  localHourInZone,
  getConversationState,
  setConversationState,
  clearConversationState,
  pruneExpiredConversationState,
  type TelegramUser,
} from './telegram-prefs';
export type { TelegramNotificationPreferences } from './schema/connections';
export { DEFAULT_TELEGRAM_PREFS } from './schema/connections';
export { getAdminActivityRows, type AdminActivityRow } from './admin-activity';
export { logError, computeFingerprint, type LogErrorInput } from './error-log';
export {
  listRecentErrors,
  listGroupedErrors,
  type ErrorFilters,
  type ErrorRangeKey,
  type RecentErrorRow,
  type GroupedErrorRow,
} from './error-log-queries';
export { assertDailyCostCap, type DailyCostCapResult } from './cost-cap';
export {
  assertDailyLaunchBudgetCap,
  assertFirstLiveLaunchCap,
  incrementLiveLaunchCount,
  type DailyLaunchCapResult,
  type FirstLaunchCapResult,
} from './launch-cap';
export {
  getDashboardMetrics,
  getPerAdBreakdown,
  getUserTimezone,
  type DashboardMetrics,
  type PerAdRow,
  type TimeRange,
} from './dashboard';
export {
  checkActiveSubscription,
  checkAdAccountSlotQuota,
  type SubscriptionGateResult,
  type SubscriptionGateReason,
  type QuotaResult,
} from './subscription';
export {
  validateInviteCode,
  createInviteCode,
  revokeInviteCode,
  listInviteCodes,
  joinWaitlist,
  listWaitlistEntries,
  approveWaitlistEntry,
  countFoundingMembers,
  type InviteCodeValidationResult,
  type CreateInviteCodeInput,
  type CreateInviteCodeResult,
  type JoinWaitlistResult,
  type ApproveWaitlistEntryResult,
} from './beta-access';
