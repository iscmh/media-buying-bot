import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  getNanoBananaJsonTemplate,
  getCharacterReplacePrompt,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';

/**
 * Polish-6 item 6: Nano Banana static image pipeline.
 *
 * For each variant:
 *   a. Claude rewrites the reference-image analysis JSON with small
 *      variant changes (background, prop, pose) using
 *      CHARACTER_REPLACE_PROMPT.
 *   b. Gemini generates the variant image using the modified JSON as
 *      the prompt (NANO_BANANA_JSON_TEMPLATE pattern).
 *   c. Store image URL on generated_creatives.
 *
 * PROMPT FIDELITY: both prompts loaded from .md files, never inlined.
 *
 * Cost: ~$0.04-0.10 per variant (cheap — text prompt + image gen).
 */

const CONCURRENCY = 5;
const MOCK_IMAGE_URL = 'https://placehold.co/720x1280/png?text=Nano+Banana+Mock';

export const generateStaticImageVariants = inngest.createFunction(
  {
    id: 'generate-static-image-variants',
    name: 'Generate Nano Banana static image variants',
    retries: 1,
  },
  { event: 'generation/nano-banana.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { variantCount: true, metadata: true },
      });
    });
    const variantCount = job?.variantCount ?? 0;
    if (variantCount <= 0) {
      await markJobFailed(jobId, userId, 'variant_count missing', 0);
      return { jobId, mode, generated: 0 };
    }

    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
    });

    if (mode === 'mock') {
      await step.sleep('mock-render', '1s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount }, () => ({
          userId,
          generationJobId: jobId,
          fileUrl: MOCK_IMAGE_URL,
          aspectRatio: '9:16' as const,
          status: 'ready_for_review' as const,
          format: 'nano_banana_static_image',
        }));
        await db.insert(schema.generatedCreatives).values(rows);
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount,
        actualCostUsd: 0,
        provider: 'gemini',
        path: 'nano-banana',
      });
      return { jobId, mode, generated: variantCount };
    }

    // Step 1: Claude generates N variant descriptions
    const variantsResult = await step.run('claude-variant-descriptions', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message, costUsd: 0 };
        throw err;
      }

      const characterReplace = getCharacterReplacePrompt();
      const nanoBanana = getNanoBananaJsonTemplate();
      const analysis = job?.metadata ?? {};

      const claude = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt: `${characterReplace}\n\nUse this JSON template for the output format:\n${nanoBanana}`,
        userMessage: JSON.stringify({
          reference_analysis: analysis,
          variant_count: variantCount,
          instructions:
            'Generate variant descriptions. Each variant should have a different background, prop, or pose while preserving the character identity. Output as JSON array of objects matching the template.',
        }),
        maxTokens: 8192,
        generationJobId: jobId,
      });
      if (!claude.ok) {
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude variant description failed',
          costUsd: claude.costUsd,
        };
      }
      const descriptions = parseVariantDescriptions(claude.json ?? claude.text, variantCount);
      if (descriptions.length === 0) {
        return {
          ok: false as const,
          error: 'No valid variant descriptions',
          costUsd: claude.costUsd,
        };
      }
      return { ok: true as const, descriptions, costUsd: claude.costUsd };
    });

    if (!variantsResult.ok) {
      await markJobFailed(jobId, userId, variantsResult.error, variantsResult.costUsd);
      return { jobId, mode, generated: 0 };
    }

    let totalCost = variantsResult.costUsd;
    const outcomes: Array<{ index: number; ok: boolean; costUsd: number; error?: string }> = [];

    for (
      let batchStart = 0;
      batchStart < variantsResult.descriptions.length;
      batchStart += CONCURRENCY
    ) {
      const batch = variantsResult.descriptions.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (desc, idxInBatch) => {
          const variantIndex = batchStart + idxInBatch;
          const genResult = await step.run(`gemini-image-${variantIndex}`, async () => {
            let keys;
            try {
              keys = await loadDecryptedKeys(userId, ['gemini']);
            } catch (err) {
              if (err instanceof MissingProviderKeyError)
                return { ok: false as const, error: err.message, costUsd: 0 };
              throw err;
            }
            return callGeminiImage({
              userId,
              apiKey: keys.gemini!,
              prompt: typeof desc === 'string' ? desc : JSON.stringify(desc),
              generationJobId: jobId,
            });
          });

          if (!genResult.ok) {
            const err =
              'errorMessage' in genResult
                ? genResult.errorMessage
                : 'error' in genResult
                  ? genResult.error
                  : 'image gen failed';
            return { index: variantIndex, ok: false, costUsd: 0, error: String(err) };
          }
          const imageUrl = 'imageUrl' in genResult ? genResult.imageUrl : undefined;
          if (!imageUrl) {
            return { index: variantIndex, ok: false, costUsd: 0, error: 'No image URL returned' };
          }

          await step.run(`write-${variantIndex}`, async () => {
            const db = getDb();
            await db.insert(schema.generatedCreatives).values({
              userId,
              generationJobId: jobId,
              fileUrl: imageUrl as string,
              aspectRatio: '9:16',
              status: 'ready_for_review',
              format: 'nano_banana_static_image',
              generationMetadata: { variant_description: desc },
            });
          });

          const cost = 'costUsd' in genResult ? (genResult.costUsd as number) : 0;
          return { index: variantIndex, ok: true, costUsd: cost };
        }),
      );
      outcomes.push(...results);
    }

    totalCost += outcomes.reduce((s, r) => s + r.costUsd, 0);
    const successCount = outcomes.filter((r) => r.ok).length;

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: successCount,
      actualCostUsd: totalCost,
      provider: 'gemini',
      path: 'nano-banana',
      partialFailures: outcomes.filter((r) => !r.ok),
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

function parseVariantDescriptions(raw: unknown, max: number): unknown[] {
  if (Array.isArray(raw)) return raw.slice(0, max);
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const arr = obj.variants ?? obj.descriptions ?? obj.images;
    if (Array.isArray(arr)) return arr.slice(0, max);
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(
        raw
          .trim()
          .replace(/^```(?:json)?\s*\n?/, '')
          .replace(/\n?```\s*$/, ''),
      );
      if (Array.isArray(parsed)) return parsed.slice(0, max);
    } catch {
      return [raw];
    }
  }
  return [];
}

void logAuditEvent;
