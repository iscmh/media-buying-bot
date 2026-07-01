export type { AIProvider, GeneratedCreative, GenerateInput } from './types';
export { getProvider, registerProvider } from './registry';
export { ArcadsProvider } from './arcads';
export { HeyGenProvider } from './heygen';
export { CreatifyProvider } from './creatify';
// Polish-8: verify-only providers for the BYOK connect cards.
export { ReplicateProvider } from './replicate';
export { OpenAIProvider } from './openai-provider';

// Phase 3b: real provider clients used by the Inngest generation jobs.
// These bypass the Phase 1 `AIProvider` interface (which was scoped to
// the older "verifyKey + generateVariants" shape) — Phase 3b's pipeline
// composes finer-grained primitives (vision, image gen, claude messages,
// async video submit + poll) so each Inngest step has a clean retry
// boundary. The legacy AIProvider interface stays for the BYOK connect UI.
export {
  callGeminiVision,
  callGeminiImage,
  rateGeminiFaceSimilarity,
  parseFaceSimilarityScore,
  verifyGeminiKey,
  uploadGeminiFile,
  pollGeminiFileReady,
  deleteGeminiFile,
  type GeminiVisionInput,
  type GeminiVisionResult,
  type GeminiImageInput,
  type GeminiImageResult,
  type GeminiFaceSimilarityInput,
  type GeminiFaceSimilarityResult,
  type UploadGeminiFileInput,
  type UploadGeminiFileResult,
  type PollGeminiFileInput,
  type PollGeminiFileResult,
} from './gemini-client';
export {
  callClaude,
  claudeRankAvatars,
  verifyClaudeKey,
  buildCinematicPromptFromScript,
  type ClaudeMessagesInput,
  type ClaudeMessagesResult,
  type ClaudeRankAvatarsResult,
  type CompactAvatar,
  type BuildCinematicPromptInput,
  type BuildCinematicPromptResult,
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

export {
  submitReplicateConcat,
  checkReplicateConcat,
  getVideoConcatModelId,
  isVideoConcatEnabled,
  type SubmitConcatInput,
  type SubmitConcatResult,
  type CheckConcatInput,
  type CheckConcatResult,
} from './replicate-concat';
export {
  submitReplicateFrameExtract,
  checkReplicateFrameExtract,
  getFrameExtractModelId,
  isFrameExtractEnabled,
  type SubmitFrameExtractInput,
  type SubmitFrameExtractResult,
  type CheckFrameExtractInput,
  type CheckFrameExtractResult,
} from './replicate-frame-extract';
export {
  submitAudioTrim,
  checkAudioTrim,
  getAudioTrimModelId,
  isAudioTrimEnabled,
  type SubmitAudioTrimInput,
  type SubmitAudioTrimResult,
  type CheckAudioTrimInput,
  type CheckAudioTrimResult,
} from './replicate-audio-trim';
export {
  submitLipsync,
  checkLipsync,
  getLipsyncModelId,
  isLipsyncEnabled,
  type SubmitLipsyncInput,
  type SubmitLipsyncResult,
  type CheckLipsyncInput,
  type CheckLipsyncResult,
} from './replicate-lipsync';
export {
  submitKieVideo,
  pollKieVideo,
  parseResultJsonOutputUrl as parseKieVideoResultJson,
  translateKieVideoErrorStatus,
  getKieVideoModelIdOverride,
  detectKieVideoRateLimit,
  computeKieVideoRateLimitBackoffMs,
  getKieVideoRateLimitMaxRetries,
  KIE_VIDEO_DEFAULT_RATE_LIMIT_MAX_RETRIES,
  __setKieVideoSleepImplForTests,
  __restoreKieVideoSleepImplForTests,
  __resetKieVideoFirstCallLogForTests,
  type KieVideoSubmitInput,
  type KieVideoSubmitResult,
  type KieVideoPollInput,
  type KieVideoPollResult,
  type KieVideoState,
} from './kie-video';

// Polish-6: vision detection + Whisper transcription for auto-format.
export {
  detectCreativeFormat,
  transcribeAudio,
  type DetectedFormat,
  type DetectedFormatClass,
  type DetectCreativeFormatInput,
  type DetectCreativeFormatResult,
  type TranscribeAudioInput,
  type TranscribeAudioResult,
} from './vision-detection';

// Polish-6: auto-routing logic.
export {
  pickPipeline,
  pipelineLabel,
  type Pipeline,
  type PostProcess,
  type PickPipelineResult,
  type PickPipelineError,
  type UserConnections as PipelineUserConnections,
  type UserPreferences as PipelineUserPreferences,
} from './pipeline-router';

// Polish-6: prompt loader — lazy-reads .md files from src/prompts/.
export {
  getUniversalUgcMasterPrompt,
  getForgeExample,
  getKling3DeconstructorSystem,
  getKling3OfficialGuide,
  getSora2DeconstructorSystem,
  getSora2OptimizerInstructions,
  getSora2Examples,
  getUgcIphoneRealismSkill,
  getNanoBananaJsonTemplate,
  getCharacterReplacePrompt,
  getPromptsBundleSize,
} from './prompt-loader';
