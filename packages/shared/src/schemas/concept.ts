import { z } from 'zod';

/**
 * Phase 3a concept upload shape. Two paths:
 *
 *   - static: image + ad copy (headline, primary, optional description)
 *   - ugc:    video + optional original script
 *
 * Both share the niche/source/offer metadata block. The discriminator is
 * `contentType` so callers can branch cleanly.
 *
 * `fileUrl` is populated by the server action AFTER the file lands in
 * Supabase Storage at /<userId>/concepts/<conceptId>/<filename>.
 *
 * Phase 1's older shape (contentType: 'video' | 'text') is preserved in
 * the DB enum for backwards compatibility but new uploads always use
 * 'static' or 'ugc'.
 */

const NICHE_TAGS = ['mmo', 'sweepstakes', 'crypto', 'nutra', 'finance', 'ecom', 'other'] as const;
export type NicheTag = (typeof NICHE_TAGS)[number];
export const NICHE_TAGS_LIST = NICHE_TAGS;

const SOURCE_PLATFORMS = ['meta', 'tiktok', 'youtube', 'other'] as const;
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];
export const SOURCE_PLATFORMS_LIST = SOURCE_PLATFORMS;

const sharedMetadata = {
  nicheTag: z.enum(NICHE_TAGS).optional(),
  sourcePlatform: z.enum(SOURCE_PLATFORMS).optional(),
  offerUrl: z.string().url().max(500).optional().or(z.literal('')),
  originalCpaUsd: z.coerce.number().nonnegative().max(10_000).optional(),
  originalRoas: z.coerce.number().nonnegative().max(100).optional(),
  description: z.string().max(2000).optional(),
};

export const StaticConceptInputSchema = z.object({
  contentType: z.literal('static'),
  staticHeadline: z.string().min(1, 'Headline is required.').max(200),
  staticPrimaryText: z.string().min(1, 'Primary text is required.').max(2000),
  staticDescription: z.string().max(500).optional(),
  ...sharedMetadata,
});

export const UgcConceptInputSchema = z.object({
  contentType: z.literal('ugc'),
  ugcOriginalScript: z.string().max(4000).optional(),
  ...sharedMetadata,
});

export const ConceptInputSchema = z.discriminatedUnion('contentType', [
  StaticConceptInputSchema,
  UgcConceptInputSchema,
]);

export type ConceptInput = z.infer<typeof ConceptInputSchema>;
export type StaticConceptInput = z.infer<typeof StaticConceptInputSchema>;
export type UgcConceptInput = z.infer<typeof UgcConceptInputSchema>;
