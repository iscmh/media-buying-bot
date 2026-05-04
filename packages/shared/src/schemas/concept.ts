import { z } from 'zod';

export const ConceptInputSchema = z.discriminatedUnion('contentType', [
  z.object({
    contentType: z.literal('video'),
    fileUrl: z.string().url(),
    description: z.string().max(2000).optional(),
  }),
  z.object({
    contentType: z.literal('text'),
    description: z.string().min(20).max(2000),
  }),
]);

export type ConceptInput = z.infer<typeof ConceptInputSchema>;
