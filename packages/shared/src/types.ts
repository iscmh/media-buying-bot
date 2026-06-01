/**
 * Domain-level shared types. DB row types live in @mbb/db.
 * Anything that crosses the web↔bot↔jobs boundary belongs here.
 */

export type UUID = string;

export type ConnectionMethod = 'byok' | 'oauth';

// Polish-8: kling/replicate/tavus/elevenlabs/openai added to the
// underlying ai_provider enum across Polish-4/6. The UI cards expose
// the ones we actually integrate with; arcads/creatify remain in the
// type so the legacy DB rows still type-check. Gemini lives in
// tool_provider (see /connections/tools), not ai_provider.
export type AIProviderName =
  | 'arcads'
  | 'heygen'
  | 'creatify'
  | 'replicate'
  | 'openai'
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
