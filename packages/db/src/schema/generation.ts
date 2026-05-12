import { sql } from 'drizzle-orm';
import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  // replaces with real Gemini Vision output.
  metadata: jsonb('metadata'),

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
  // context here.
  generationMetadata: jsonb('generation_metadata').default({}),

  // Soft delete.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
