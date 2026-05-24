import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  aiProviderEnum,
  aspectRatioEnum,
  creativeStatusEnum,
  generationJobStatusEnum,
} from './enums';
import { users } from './users';

export const generationJobs = pgTable('generation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  conceptIds: uuid('concept_ids')
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),

  // Phase 1 used this for UGC-provider scoping; Phase 3a static jobs use
  // Gemini + Claude (which live in tool_connections), so this is now
  // nullable. UGC jobs populate it; static jobs leave it null. The actual
  // user-picked provider lives in providerChoice (free-form text, accepts
  // values from either ai_provider enum or tool_provider enum).
  aiProviderUsed: aiProviderEnum('ai_provider_used'),

  status: generationJobStatusEnum('status').notNull().default('queued'),

  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),

  generatedCreativeCount: integer('generated_creative_count').notNull().default(0),
  errorMessage: text('error_message'),

  // Phase 3a additions.
  intensity: text('intensity'),
  variantCount: integer('variant_count'),
  providerChoice: text('provider_choice'),
  estimatedCostUsd: numeric('estimated_cost_usd', { precision: 10, scale: 4 }),
  actualCostUsd: numeric('actual_cost_usd', { precision: 10, scale: 4 }),
  mode: text('mode').default('mock'),
  // Where analyze-concept stuffs its mock structured analysis. Phase 3b
  // replaces with real Gemini Vision output. Polish-4 also writes
  // provider-switch decisions here under metadata.failover_log.
  metadata: jsonb('metadata'),

  // Polish-4: creative format. 'avatar_talking_head' (HeyGen) or
  // 'cinematic_voiceover' (Kling). text rather than enum so future
  // formats don't need an ALTER TYPE round-trip.
  format: text('format').notNull().default('avatar_talking_head'),

  // Polish-6: vision detection output. Full structured JSON from
  // detectCreativeFormat — format class, demographics, setting,
  // tone, pacing, visual elements, extracted dialogue.
  detectedFormat: jsonb('detected_format'),
  // Polish-6: the pipeline the router picked (e.g.
  // 'heygen_avatar_talking_head', 'kling_3_multi_clip_native_lipsync',
  // 'sora_2_single_shot', 'nano_banana_static_image').
  pickedPipeline: text('picked_pipeline'),
  // Polish-6: Supabase Storage path for the user's uploaded reference
  // creative (video or image). The vision detection step reads from
  // this path; downstream pipelines may re-read it for frame extraction.
  referenceCreativeStoragePath: text('reference_creative_storage_path'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const generatedCreatives = pgTable('generated_creatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  generationJobId: uuid('generation_job_id')
    .notNull()
    .references(() => generationJobs.id, { onDelete: 'cascade' }),

  // Full public URL (Phase 3c+). Storage object key lives in
  // image_storage_path for backend deletion / archival.
  fileUrl: text('file_url').notNull(),
  imageStoragePath: text('image_storage_path'),

  // Phase 3c: Claude-generated copy actually persisted (was dropped on
  // the floor pre-3c — only the index columns below existed).
  headline: text('headline'),
  primaryText: text('primary_text'),
  description: text('description'),

  // Legacy 2D-matrix indices. Kept nullable for backward compat; Phase 3c
  // populates all three with the same value as variant_index for
  // consistency until the 2D matrix architecture is built (if ever).
  hookVariantIndex: integer('hook_variant_index'),
  bodyVariantIndex: integer('body_variant_index'),
  ctaVariantIndex: integer('cta_variant_index'),

  aspectRatio: aspectRatioEnum('aspect_ratio').notNull(),
  status: creativeStatusEnum('status').notNull().default('pending'),

  // Flex bag for provider response details (prompt used, latency_ms,
  // claude_rationale, errors). Phase 3c stores per-variant generation
  // context here. Polish-4 also stores cinematic prompt + audio URL
  // when format='cinematic_voiceover'.
  generationMetadata: jsonb('generation_metadata').default({}),

  // Polish-4: creative format (mirrors generationJobs.format on the
  // variant row — needed for per-variant rendering / cost rollups).
  format: text('format').notNull().default('avatar_talking_head'),

  // Polish-6: multi-clip pipeline. Kling 3.0 produces 16 sub-clips
  // per variant; each sub-clip gets its own generated_creatives row
  // with clip_index (0-15) + is_clip_part=true. The final muxed
  // output (if muxing succeeded) gets is_clip_part=false.
  clipIndex: integer('clip_index'),
  isClipPart: boolean('is_clip_part').notNull().default(false),

  // Soft delete.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
