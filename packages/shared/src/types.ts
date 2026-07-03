/**
 * Domain-level shared types. DB row types live in @mbb/db.
 * Anything that crosses the web↔bot↔jobs boundary belongs here.
 */

export type UUID = string;

export type ConnectionMethod = 'byok' | 'oauth';

// Polish-20 Commit 4 removed 'elevenlabs' from the application-level
// union alongside the legacy Kling pipelines. Polish-21.0.4 hotfix
// brings it BACK: Hedra Character 3's native TTS is blocked on voice
// UUIDs not available on Creator plan, so the worker generates audio
// via ElevenLabs BYOK and hands the mp3 to Hedra as an audio_id
// asset. The underlying pg enum in @mbb/db always carried
// 'elevenlabs' (never dropped), so no DB migration is needed for
// the re-add. arcads / creatify stay for legacy DB rows.
// Gemini + Claude + Kie.ai live in tool_provider (see
// /connections/tools), not ai_provider.
export type AIProviderName =
  | 'arcads'
  | 'heygen'
  | 'creatify'
  | 'replicate'
  | 'openai'
  // Polish-21: Hedra Character 3 image-to-talking-avatar. Replaces
  // the Polish-20 kie.ai 3-model text-to-video pipeline. BYOK key
  // stored in ai_provider_connections under provider='hedra'.
  | 'hedra'
  // Polish-21.0.4 hotfix: ElevenLabs TTS BYOK. Worker generates
  // audio via ElevenLabs and uploads the mp3 as a Hedra audio
  // asset — bypasses Hedra's native TTS voice-UUID dependency.
  | 'elevenlabs';

export type CampaignObjective = 'CBO' | 'ABO';

export type AdStatus =
  | 'pending'
  | 'launching'
  | 'active'
  | 'killed'
  | 'scaled'
  | 'completed'
  | 'rejected'
  | 'paused';

export type GenerationJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export type AspectRatio = '9:16' | '1:1' | '4:5';

export type UserRole = 'user' | 'admin';

export type PauseActor = 'user' | 'admin' | 'auto';

export type ConceptContentType = 'video' | 'text';

/** Result of a spend safety check before any Meta mutation. */
export type SpendSafetyResult =
  | { allow: true }
  | { allow: false; reason: string; code: SpendSafetyDenyCode };

export type SpendSafetyDenyCode =
  | 'platform_ceiling_exceeded'
  | 'user_ceiling_exceeded'
  | 'user_paused'
  | 'global_emergency_stop'
  | 'token_expired'
  | 'token_missing'
  | 'rate_limited'
  | 'suspicious_activity_pause';
