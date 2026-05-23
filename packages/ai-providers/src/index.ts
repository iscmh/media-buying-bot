export type { AIProvider, GeneratedCreative, GenerateInput } from './types';
export { getProvider, registerProvider } from './registry';
export { ArcadsProvider } from './arcads';
export { HeyGenProvider } from './heygen';
export { CreatifyProvider } from './creatify';

// Phase 3b: real provider clients used by the Inngest generation jobs.
// These bypass the Phase 1 `AIProvider` interface (which was scoped to
// the older "verifyKey + generateVariants" shape) — Phase 3b's pipeline
// composes finer-grained primitives (vision, image gen, claude messages,
// async video submit + poll) so each Inngest step has a clean retry
// boundary. The legacy AIProvider interface stays for the BYOK connect UI.
export {
  callGeminiVision,
  callGeminiImage,
  verifyGeminiKey,
  uploadGeminiFile,
  pollGeminiFileReady,
  deleteGeminiFile,
  type GeminiVisionInput,
  type GeminiVisionResult,
  type GeminiImageInput,
  type GeminiImageResult,
  type UploadGeminiFileInput,
  type UploadGeminiFileResult,
  type PollGeminiFileInput,
  type PollGeminiFileResult,
} from './gemini-client';
export {
  callClaude,
  claudeRankAvatars,
  verifyClaudeKey,
  type ClaudeMessagesInput,
  type ClaudeMessagesResult,
  type ClaudeRankAvatarsResult,
  type CompactAvatar,
} from './claude-client';
export {
  submitKieAiVideo,
  checkKieAiVideoStatus,
  type KieSubmitInput,
  type KieSubmitResult,
  type KieCheckInput,
  type KieCheckResult,
  type KieTaskStatus,
} from './kie-ai-client';
export {
  listHeyGenAvatars,
  listHeyGenVoices,
  pickHeyGenAvatar,
  submitHeyGenVideo,
  checkHeyGenVideoStatus,
  classifyHeyGenError,
  detectHeyGenTier,
  filterAvatarsByTier,
  normalizeHeyGenAvatar,
  HeyGenAvatarNotConfiguredError,
  type HeyGenAvatar,
  type HeyGenAvatarsListResult,
  type HeyGenVoice,
  type HeyGenVoicesListResult,
  type HeyGenSubmitInput,
  type HeyGenSubmitResult,
  type HeyGenCheckInput,
  type HeyGenCheckResult,
  type HeyGenStatus,
  type HeyGenErrorCategory,
  type HeyGenTier,
} from './heygen-client';
export {
  callProvider,
  type ProviderName as ProviderChokepointName,
  type CallProviderInput,
  type CallProviderResult,
} from './chokepoint';
