export type { AIProvider, GeneratedCreative, GenerateInput } from './types';
export { getProvider, registerProvider } from './registry';
export { ArcadsProvider } from './arcads';
export { HeyGenProvider } from './heygen';
export { CreatifyProvider } from './creatify';
// Polish-8: verify-only providers for the BYOK connect cards.
export { ReplicateProvider } from './replicate';
export { OpenAIProvider } from './openai-provider';
// Polish-25.3 Commit 18b: OpenAI image-gen client (gpt-image-2)
// for the new "Static ad" pipeline. Reference-image-anchored via
// /v1/images/edits; typed errors for content policy / quota /
// rate-limit / bad reference image.
export {
  submitOpenaiImageGeneration,
  estimateOpenaiImageCostUsd,
  isOpenaiTransientError,
  redactOpenaiApiKey,
  OpenaiRateLimitError,
  OpenaiContentPolicyError,
  OpenaiInsufficientFundsError,
  OpenaiInvalidImageError,
  OpenaiTransientError,
  OpenaiTimeoutError,
  // Polish-25.9 Commit 58: raw-string classifier + describe helper
  // for user-actionable OpenAI error surface. Named ...Message to
  // avoid collision with the internal classifyOpenaiError() that
  // takes a structured HTTP response payload.
  classifyOpenaiErrorMessage,
  describeOpenaiError,
  type OpenaiErrorCategory,
  type OpenaiErrorClassification,
  OPENAI_IMAGE_DEFAULT_MODEL,
  OPENAI_IMAGE_MODELS,
  OPENAI_IMAGE_QUALITIES,
  OPENAI_IMAGE_SIZES,
  OPENAI_GPT_IMAGE_2_HIGH_USD_PER_IMAGE,
  OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE,
  OPENAI_GPT_IMAGE_2_LOW_USD_PER_IMAGE,
  OPENAI_GPT_IMAGE_2_HIGH_RECT_USD_PER_IMAGE,
  OPENAI_GPT_IMAGE_2_MEDIUM_RECT_USD_PER_IMAGE,
  OPENAI_GPT_IMAGE_2_LOW_RECT_USD_PER_IMAGE,
  type OpenaiImageInput,
  type OpenaiImageResult,
  type OpenaiImageModel,
  type OpenaiImageQuality,
  type OpenaiImageSize,
} from './openai-image-client';
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
  // Polish-28.0.0 Commit 64: Instant Voice Clone + cleanup + reaper support.
  POLISH28_TEMP_VOICE_NAME_PREFIX,
  createInstantVoiceClone,
  deleteElevenLabsVoice,
  listElevenLabsVoices,
  type CreateInstantVoiceCloneInput,
  type CreateInstantVoiceCloneResult,
  type DeleteElevenLabsVoiceInput,
  type DeleteElevenLabsVoiceResult,
  type ListElevenLabsVoicesInput,
  type ListElevenLabsVoicesResult,
  type ListedElevenLabsVoice,
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
  analyzeMakeugcAvatarThumbnail,
  isGeminiInlineImageMimeSupported,
  resolveInlineImageMime,
  type MimeResolutionResult,
  type AnalyzeMakeugcAvatarThumbnailInput,
  type AnalyzeMakeugcAvatarThumbnailResult,
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
  // Polish-25.8 Commit 54: shared Gemini error classifier — used by
  // Files upload path + Commit 56 static-variants image-gen path.
  classifyGeminiUploadError,
  describeGeminiUploadError,
  // Polish-25.8 Commit 53: Gemini vision model resolver + env override.
  DEFAULT_GEMINI_VISION_MODEL,
  // Polish-28.0.0 Commit 64: Nano Banana Pro character-clone image gen.
  cloneCharacterReferenceImage,
  NANO_BANANA_PRO_DEFAULT_MODEL_ID,
  NANO_BANANA_STANDARD_MODEL_ID,
  composeNanoBananaCharacterClonePrompt,
  nanoBananaProModel,
  // Polish-28.0.2 Commit 64.2 hotfix: persona shape coercer — accepts
  // the Polish-23 structured object OR a freeform string.
  flattenPersonaForClonePrompt,
  type CloneCharacterReferenceImageInput,
  type CloneCharacterReferenceImageResult,
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
// Polish-25 Commit 1: MakeUGC pivot exports (client-only).
export {
  MAKEUGC_AVATAR_CACHE_TTL_MS,
  MAKEUGC_CREDITS_PER_VIDEO,
  MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS,
  MAKEUGC_USD_PER_CREDIT_PRO_APPROX,
  MAKEUGC_USD_PER_CREDIT_STARTER,
  MAKEUGC_VOICE_CACHE_TTL_MS,
  MAKEUGC_VOICE_SCRIPT_MAX_CHARS,
  MakeugcInsufficientCreditsError,
  MakeugcNoMatchingAvatarError,
  MakeugcScriptTooLongError,
  MakeugcVoiceScriptSchema,
  Polish25AvatarMatchMetadataSchema,
  Polish25CreditsUsedMetadataSchema,
  __resetMakeugcCachesForTests,
  assertMakeugcScriptLength,
  checkMakeugcVideoStatus,
  classifyMakeugcError,
  estimateMakeugcVideoCostUsd,
  invalidateMakeugcAvatarCache,
  invalidateMakeugcVoiceCache,
  isMakeugcTransientError,
  listMakeugcAvatars,
  listMakeugcAvatarsCached,
  listMakeugcVoices,
  listMakeugcVoicesCached,
  normalizeMakeugcAvatar,
  normalizeMakeugcVoice,
  selectMakeugcAvatarForPersona,
  // Polish-25 Commit 7: enriched-index matcher + supporting exports.
  selectMakeugcAvatarForPersonaFromIndex,
  personaAgeRangeToBucket,
  ageBucketNeighbors,
  MAKEUGC_ENRICHED_SCORE_WEIGHTS,
  submitMakeugcVideo,
  type ListMakeugcAvatarsInput,
  type ListMakeugcVoicesInput,
  type MakeugcAvatar,
  type MakeugcAvatarMatch,
  type MakeugcAvatarMatchLog,
  type MakeugcAvatarsListResult,
  type MakeugcCheckInput,
  type MakeugcCheckResult,
  type MakeugcEnrichedAvatar,
  type MakeugcEnrichedMatchLog,
  type MakeugcEnrichedMatchResult,
  type MakeugcErrorCategory,
  type MakeugcPersona,
  type MakeugcSubmitInput,
  type MakeugcSubmitResult,
  type MakeugcTier,
  type MakeugcVideoStatus,
  type MakeugcVoice,
  type MakeugcVoicesListResult,
  type Polish25AvatarMatchMetadata,
  type Polish25CreditsUsedMetadata,
} from './makeugc-client';
// Polish-26 Commit 61: HeyGen v3 PAYG managed-backend client
// (parallel-track alongside the Polish-24 heygen-client exports
// above — see file header for the coexistence rationale).
//
// Symbols with names that collide with the Polish-24 exports get
// aliased with the `V3` suffix here so callers can unambiguously
// pick the version they want. Non-colliding names (submit, list,
// classify, cost helpers) keep their original identifiers because
// the Polish-24 client exposes those under different names anyway.
export {
  HEYGEN_DEFAULT_VIDEO_SECONDS,
  HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS as HEYGEN_V3_TRANSIENT_ERROR_MESSAGE_PATTERNS,
  // Polish-26.0.1: primary estimator constants use the public
  // pricing standard rate. Help-center per-engine rates are still
  // exported (below) as *_HELPCENTER for the future invoice true-up.
  HEYGEN_USD_PER_EFFECT_VIDEO,
  HEYGEN_USD_PER_SECOND_EXTENDED,
  HEYGEN_USD_PER_SECOND_STANDARD,
  HEYGEN_USD_PER_SECOND_AVATAR_IV_1080P_HELPCENTER,
  HEYGEN_USD_PER_SECOND_AVATAR_IV_4K_HELPCENTER,
  HEYGEN_USD_PER_SECOND_AVATAR_V_HELPCENTER,
  HEYGEN_VOICE_SCRIPT_MAX_CHARS,
  HeygenModerationRejectedError,
  HeygenNoMatchingAvatarError as HeygenV3NoMatchingAvatarError,
  HeygenQuotaExhaustedError,
  HeygenScriptTooLongError,
  Polish26HeygenAvatarMatchMetadataSchema,
  Polish26HeygenCostMetadataSchema,
  assertHeygenScriptLength,
  checkHeygenVideoStatus,
  classifyHeygenError,
  estimateHeygenVideoCostUsd,
  isHeygenTransientError as isHeygenV3TransientError,
  listHeygenAvatars,
  listHeygenVoices,
  selectHeygenAvatarForPersonaFromIndex,
  submitHeygenVideo,
  type CheckHeygenVideoStatusInput,
  type CheckHeygenVideoStatusResult,
  type EstimateHeygenVideoCostInput,
  type HeygenAvatarMatch as HeygenV3AvatarMatch,
  type HeygenAvatarMatchLog as HeygenV3AvatarMatchLog,
  type HeygenAvatarV3,
  type HeygenAvatarsListResult,
  type HeygenEngine,
  type HeygenEnrichedAvatar,
  type HeygenErrorCategory,
  type HeygenPersona as HeygenV3Persona,
  type HeygenVideoStatus,
  type HeygenVoiceV3,
  type HeygenVoicesListResult,
  type ListHeygenAvatarsInput,
  type ListHeygenVoicesInput,
  type SubmitHeygenVideoInput,
  type SubmitHeygenVideoResult,
} from './heygen-v3-client';

// Polish-28.0.0 Commit 64: HeyGen Avatar IV image-to-video client
// (BYOK per user). Distinct from the v3 pre-cast-avatar client above
// — takes a caller-supplied reference image + audio URL, returns a
// lip-synced video.
export {
  POLISH28_ASPECT_RATIO,
  heygenAvatarIvCostPerSecUsd,
  estimateHeygenAvatarIvCostUsd,
  uploadHeygenImageAsset,
  uploadHeygenAudioAsset,
  fetchHeygenVoices,
  matchHeygenVoiceForPersona,
  type HeygenVoice,
  submitHeygenAvatarIvGeneration,
  checkHeygenAvatarIvStatus,
  isTerminalAvatarIvStatus,
  classifyHeygenAvatarIvError,
  HeygenAvatarIvAuthError,
  HeygenAvatarIvModerationError,
  HeygenAvatarIvQuotaError,
  type Polish28AspectRatio,
  type HeygenAvatarIvErrorCategory,
  type HeygenAvatarIvVideoStatus,
  type UploadHeygenImageAssetInput,
  type UploadHeygenImageAssetResult,
  type SubmitHeygenAvatarIvInput,
  type SubmitHeygenAvatarIvResult,
  type CheckHeygenAvatarIvStatusInput,
  type CheckHeygenAvatarIvStatusResult,
} from './heygen-avatar-iv-client';

export {
  callProvider,
  type ProviderName as ProviderChokepointName,
  type CallProviderInput,
  type CallProviderResult,
} from './chokepoint';

// Polish-29.0.2 Commit 112: credit router — gates credit ledger
// around individual model calls. Every credit-billed provider client
// wraps its call with `withCreditReservation`; BYOK models pass
// through unchanged.
//
// Polish-29.0.12 Commit 121: getModelCostPreview + ModelCostPreview
// relocated to @mbb/shared/credit-pricing.ts so client components can
// import them without dragging @mbb/db + postgres + node:crypto into
// the browser bundle. Client callers must switch to `@mbb/shared`.
// This barrel no longer re-exports them from `./credit-router` because
// even a `export {}` line would pull the router module (and its @mbb/db
// import) into any client bundle that touches @mbb/ai-providers.
export {
  withCreditReservation,
  defaultResultOk,
  type CreditRouterOutcome,
  type ResultOk,
  type WithCreditReservationOptions,
} from './credit-router';
// Convenience re-export so consumers of `@mbb/ai-providers` don't need
// a second import from `@mbb/db` just to catch the credits error.
// Kept out of credit-router.ts itself to avoid a TDZ interaction with
// vitest's `vi.mock('@mbb/db', ...)` in the router's unit tests.
export { InsufficientCreditsError } from '@mbb/db';

// Polish-29.0.0 Commit 110: useapi.net multi-service client
// (Google Flow + Dreamina to start; Kling / Runway / PixVerse /
// MiniMax slot in on the same shape as accounts are registered).
export {
  getUseapiNetToken,
  isUseapiNetConfigured,
  registerGoogleFlowAccount,
  registerDreaminaAccount,
  getDreaminaAccountBalance,
  uploadUseapiAsset,
  checkUseapiJob,
  submitVeoVideo,
  submitNanoBananaImage,
  submitSeedanceVideo,
  submitSeedreamImage,
  UseapiNetConfigError,
  UseapiNetAccountError,
  UseapiNetJobError,
  type UseapiService,
  type UseapiJobStatus,
  type UseapiJobResult,
  type GoogleFlowAccountInput,
  type DreaminaAccountInput,
  type RegisterAccountResult,
  type UploadAssetInput,
  type UploadAssetResult,
  type CheckJobInput,
  type SubmitJobResult,
  type SubmitVeoVideoInput,
  type SubmitNanoBananaImageInput,
  type SubmitSeedanceVideoInput,
  type SubmitSeedreamImageInput,
} from './useapi-net-client';

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
