export type { AIProvider, GeneratedCreative, GenerateInput } from './types';
export { getProvider, registerProvider } from './registry';
export { ArcadsProvider } from './arcads';
export { HeyGenProvider } from './heygen';
export { CreatifyProvider } from './creatify';
// Polish-8: verify-only providers for the BYOK connect cards.
export { ReplicateProvider } from './replicate';
export { OpenAIProvider } from './openai-provider';
// Polish-21: Hedra Character 3 BYOK verify card.
export { HedraProvider } from './hedra';
// Polish-21.0.4 hotfix: ElevenLabs TTS BYOK verify card + client.
export {
  ElevenLabsProvider,
  submitElevenLabsTts,
  verifyElevenLabsKey,
  translateElevenLabsErrorStatus,
  extractElevenLabsErrorMessage,
  redactElevenLabsApiKey,
  logElevenLabsRequest,
  logElevenLabsResponse,
  bytesToBuffer,
  ELEVENLABS_DEFAULT_MODEL_ID,
  ELEVENLABS_UGC_VOICE_SETTINGS,
  type ElevenLabsTtsInput,
  type ElevenLabsTtsResult,
} from './elevenlabs';

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
  // Polish-21.0.8: Nano Banana 2 model resolver + env override.
  DEFAULT_NANO_BANANA_MODEL_ID,
  getNanoBananaModelId,
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
  // Polish-24 Commit 1: HeyGen pivot exports (client-only)
  HEYGEN_AVATAR_III_USD_PER_SEC,
  HEYGEN_AVATAR_IV_1080P_USD_PER_SEC,
  HEYGEN_AVATAR_IV_4K_USD_PER_SEC,
  HEYGEN_USD_PER_SECOND,
  HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS,
  HEYGEN_APPEARANCE_WORD_PATTERNS,
  HEYGEN_AVATAR_CACHE_TTL_MS,
  HEYGEN_VOICE_CACHE_TTL_MS,
  HeygenInputTextSchema,
  HeygenNoMatchingAvatarError,
  HeygenAvatarChurnedError,
  Polish24AvatarMatchMetadataSchema,
  __resetHeygenCachesForTests,
  assertNoAvatarAppearanceWordsInInputText,
  containsAvatarAppearanceWords,
  estimateHeygenClipCostUsd,
  invalidateHeygenAvatarCache,
  invalidateHeygenVoiceCache,
  isHeygenTransientError,
  listHeygenAvatarsCached,
  listHeygenVoicesCached,
  selectHeygenAvatarForPersona,
  submitHeygenPolish24Video,
  submitHeygenPolish24VideoWithChurnRetry,
  type HeygenAvatarMatch,
  type HeygenAvatarMatchLog,
  type HeygenChurnRetryInput,
  type HeygenChurnRetryResult,
  type HeygenPersona,
  type HeygenPolish24SubmitInput,
  type HeygenPolish24SubmitResult,
  type HeygenTier as HeygenPolish24Tier,
  type Polish24AvatarMatchMetadata,
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

// Polish-21: Hedra Character 3 image-to-talking-avatar client.
export {
  createHedraAsset,
  uploadHedraAsset,
  submitHedraGeneration,
  pollHedraGeneration,
  buildHedraStatusUrl,
  listHedraVoices,
  verifyHedraKey,
  normalizeHedraStatus,
  translateHedraErrorStatus,
  extractHedraErrorMessage,
  renderFastApiDetail,
  clampHedraDurationMs,
  HEDRA_DEFAULT_DURATION_MS,
  HEDRA_MIN_DURATION_MS,
  HEDRA_MAX_DURATION_MS,
  // Polish-21.0.9: env-override resolvers for the three Hedra
  // model UUIDs (Character 3 + Kling Avatar v2 Standard + Pro).
  getHedraCharacter3ModelId,
  getHedraKlingV2StandardModelId,
  getHedraKlingV2ProModelId,
  resolveHedraModelIdForVideoModel,
  // Polish-21.0.10: terminal-state guards used by the worker's
  // Hedra poll loop.
  isTerminalHedraStatus,
  isFailedHedraStatus,
  redactHedraApiKey,
  logHedraRequest,
  logHedraResponse,
  __resetHedraFirstCallLogForTests,
  __resetHedra404LogForTests,
  type HedraAssetType,
  type HedraCreateAssetInput,
  type HedraCreateAssetResult,
  type HedraUploadAssetInput,
  type HedraUploadAssetResult,
  type HedraTtsInput,
  type HedraSubmitGenerationInput,
  type HedraSubmitGenerationResult,
  type HedraPollStatusInput,
  type HedraPollStatusResult,
  type HedraGenerationStatus,
  type HedraVoicesListInput,
  type HedraVoicesListResult,
  type HedraVoiceRaw,
} from './hedra-video';

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

// Polish-23 Commit 1: WaveSpeedAI-hosted Higgsfield Soul
// image-to-image client. Reference-image seed for the new
// kie.ai Veo 3.1 Lite pipeline. Commit 3 wires the worker;
// the client + BYOK card + estimator branch land here at
// Commit 1.
export {
  submitWavespeedSoul,
  pollWavespeedSoul,
  verifyWavespeedKey,
  normalizeWavespeedStatus,
  translateWavespeedErrorStatus,
  isWavespeedTransientError,
  WAVESPEED_TRANSIENT_ERROR_MESSAGE_PATTERNS,
  estimateWavespeedSoulCostUsd,
  WAVESPEED_SOUL_USD_PER_RUN,
  WAVESPEED_SOUL_DEFAULT_QUALITY,
  type WavespeedQuality,
  type WavespeedSoulSubmitInput,
  type WavespeedSoulSubmitResult,
  type WavespeedSoulPollInput,
  type WavespeedSoulPollResult,
  type WavespeedPredictionStatus,
} from './wavespeed';
export { composeHiggsfieldSoulReferencePrompt } from './higgsfield-soul-prompt';
// Polish-23 Commit 2: kie.ai Veo 3.1 Lite client + per-segment
// prompt composer with CHARACTER LOCK prefix.
export {
  submitKieVeoLite,
  pollKieVeoLite,
  buildKieVeoRequestBody,
  extractVeoOutputUrl,
  mapKieVeoSuccessFlag,
  translateKieVeoErrorStatus,
  classifyKieVeoErrorKind,
  detectKieVeoRateLimit,
  computeKieVeoRateLimitBackoffMs,
  getKieVeoRateLimitMaxRetries,
  getVeoLiteModelId,
  getKieVeoLiteUsdPerClip,
  estimateKieVeoLiteClipCostUsd,
  VEO_LITE_DEFAULT_MODEL_ID,
  KIE_VEO_LITE_DEFAULT_USD_PER_CLIP,
  KIE_VEO_LITE_DEFAULT_CLIP_SECONDS,
  KIE_VEO_LITE_DEFAULT_CREDITS_PER_CLIP,
  KIE_VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES,
  __setKieVeoSleepImplForTests,
  __restoreKieVeoSleepImplForTests,
  __resetKieVeoFirstCallLogForTests,
  type KieVeoState,
  type KieVeoSubmitInput,
  type KieVeoSubmitResult,
  type KieVeoPollInput,
  type KieVeoPollResult,
} from './kie-veo';
export {
  composeVeoLiteSegmentPrompt,
  composeCharacterLockPrefix,
  composeReferenceImageCaption,
  composeSettingInvariantBlock,
  countDialogueWords,
  checkDialogueWordCount,
  POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS,
  POLISH23_VEO_SEED_MAX,
  POLISH23_VEO_SEED_MIN,
  VEO_LITE_WPM,
  VEO_LITE_CLIP_SECONDS,
  VEO_LITE_MIN_DIALOGUE_WORDS,
  VEO_LITE_MAX_DIALOGUE_WORDS,
  type VeoLiteSegmentSpec,
  type DialogueWordCountCheck,
  type ComposedVeoLiteSegmentPrompt,
} from './veo-lite-segment-prompt';
