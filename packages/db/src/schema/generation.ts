import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  aiProviderUsed: aiProviderEnum('ai_provider_used').notNull(),

  status: generationJobStatusEnum('status').notNull().default('queued'),

  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),

  generatedCreativeCount: integer('generated_creative_count').notNull().default(0),
  errorMessage: text('error_message'),

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

  fileUrl: text('file_url').notNull(),

  // Combinatorial mixing indices: which hook × which body × which CTA.
  hookVariantIndex: integer('hook_variant_index'),
  bodyVariantIndex: integer('body_variant_index'),
  ctaVariantIndex: integer('cta_variant_index'),

  aspectRatio: aspectRatioEnum('aspect_ratio').notNull(),
  status: creativeStatusEnum('status').notNull().default('pending'),

  // Soft delete.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
