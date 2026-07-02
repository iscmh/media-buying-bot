/**
 * Domain-level shared types. DB row types live in @mbb/db.
 * Anything that crosses the web↔bot↔jobs boundary belongs here.
 */

export type UUID = string;

export type ConnectionMethod = 'byok' | 'oauth';

// Polish-20 Commit 4: elevenlabs removed alongside the legacy Kling
// pipelines that used it. The underlying pg enum in @mbb/db still
// carries 'elevenlabs' for stale DB rows — this application-level
// union just stops surfacing it. arcads / creatify stay for legacy
// DB rows. Gemini + Claude + Kie.ai live in tool_provider (see
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
  | 'hedra';

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
