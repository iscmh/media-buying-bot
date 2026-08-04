import { eq } from 'drizzle-orm';
import {
  callClaude,
  getSora2OptimizerInstructions,
  checkKieAiVideoStatus,
  submitKieAiVideo,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';

/**
 * Polish-6 item 5: Sora 2 single-shot pipeline.
 *
 * Two paths:
 *   a. Reference video provided → Gemini deconstructor + Claude
 *      optimizer → polished 5000-char Sora 2 prompt (two-step chain).
 *   b. No reference → Claude generates a Sora 2 prompt from scratch
 *      using SORA_2_OPTIMIZER_INSTRUCTIONS.
 *
 * Then: submit to Sora 2 via Kie.ai's Sora-2-pro endpoint (the only
 * currently available public API wrapper). If OpenAI ships a direct
 * Sora generation API in the future, add it as a preferred path.
 *
 * PROMPT FIDELITY: SORA_2_OPTIMIZER_INSTRUCTIONS loaded from .md
 * via getSora2OptimizerInstructions(), never inlined.
 */

const CONCURRENCY = 2;
const POLL_INTERVAL_SECONDS = 15;
const POLL_MAX_ATTEMPTS = 80;
const MOCK_VIDEO_URL = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

export const generateSoraVariants = inngest.createFunction(
  {
    id: 'generate-sora-variants',
    name: 'Generate Sora 2 single-shot variants',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/sora.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { variantCount: true, intensity: true, metadata: true },
      });
    });
    const variantCount = job?.variantCount ?? 0;
    const intensity = (job?.intensity ?? 'medium') as 'small' | 'medium' | 'big';
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
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount }, () => ({
          userId,
          generationJobId: jobId,
          fileUrl: MOCK_VIDEO_URL,
          aspectRatio: '9:16' as const,
          status: 'ready_for_review' as const,
          format: 'sora_2_single_shot',
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
        provider: 'sora',
        path: 'sora',
      });
      return { jobId, mode, generated: variantCount };
    }

    // Step 1: generate N Sora prompts from analysis + intensity
    const promptResult = await step.run('claude-sora-prompts', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message, costUsd: 0 };
        throw err;
      }
      const systemPrompt = getSora2OptimizerInstructions();
      const analysis = job?.metadata ?? {};
      const claude = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt,
        userMessage: JSON.stringify({ analysis, intensity, variant_count: variantCount }),
        maxTokens: 8192,
        generationJobId: jobId,
      });
      if (!claude.ok) {
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude Sora prompt generation failed',
          costUsd: claude.costUsd,
        };
      }
      const prompts = parseSoraPrompts(claude.json ?? claude.text, variantCount);
      if (prompts.length === 0) {
        return {
          ok: false as const,
          error: 'No valid Sora prompts from Claude',
          costUsd: claude.costUsd,
        };
      }
      return { ok: true as const, prompts, costUsd: claude.costUsd };
    });

    if (!promptResult.ok) {
      await markJobFailed(jobId, userId, promptResult.error, promptResult.costUsd);
      return { jobId, mode, generated: 0 };
    }

    let totalCost = promptResult.costUsd;
    const outcomes: Array<{ index: number; ok: boolean; costUsd: number; error?: string }> = [];

    for (let batchStart = 0; batchStart < promptResult.prompts.length; batchStart += CONCURRENCY) {
      const batch = promptResult.prompts.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (prompt, idxInBatch) => {
          const variantIndex = batchStart + idxInBatch;

          // Submit via Kie.ai (Sora 2 wrapper)
          const submitResult = await step.run(`sora-submit-${variantIndex}`, async () => {
            let keys;
            try {
              keys = await loadDecryptedKeys(userId, ['kie_ai']);
            } catch (err) {
              if (err instanceof MissingProviderKeyError)
                return { ok: false as const, error: err.message };
              throw err;
            }
            return submitKieAiVideo({
              userId,
              apiKey: keys.kie_ai!,
              prompt: prompt.slice(0, 5000),
              generationJobId: jobId,
            });
          });

          if (!submitResult.ok || !('taskId' in submitResult) || !submitResult.taskId) {
            const err =
              'errorMessage' in submitResult
                ? submitResult.errorMessage
                : 'error' in submitResult
                  ? submitResult.error
                  : 'submit failed';
            return { index: variantIndex, ok: false, costUsd: 0, error: String(err) };
          }

          // Poll
          let videoUrl: string | undefined;
          let pollError: string | undefined;
          let pollCostUsd = 0;
          for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
            await step.sleep(`sora-poll-${variantIndex}-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
            const tick = await step.run(`sora-check-${variantIndex}-${attempt}`, async () => {
              const keys = await loadDecryptedKeys(userId, ['kie_ai']);
              return checkKieAiVideoStatus({
                userId,
                apiKey: keys.kie_ai!,
                taskId: submitResult.taskId!,
                generationJobId: jobId,
              });
            });
            if (tick.status === 'completed') {
              videoUrl = tick.videoUrl;
              pollCostUsd = tick.costUsd ?? 0;
              break;
            }
            if (tick.status === 'failed') {
              pollError = tick.errorMessage ?? 'Sora generation failed';
              break;
            }
          }

          if (!videoUrl) {
            return {
              index: variantIndex,
              ok: false,
              costUsd: pollCostUsd,
              error:
                pollError ??
                `Sora did not finish within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS}s`,
            };
          }

          await step.run(`write-${variantIndex}`, async () => {
            const db = getDb();
            await db.insert(schema.generatedCreatives).values({
              userId,
              generationJobId: jobId,
              fileUrl: videoUrl!,
              aspectRatio: '9:16',
              status: 'ready_for_review',
              format: 'sora_2_single_shot',
              generationMetadata: { sora_prompt: prompt.slice(0, 5000) },
            });
          });
          return { index: variantIndex, ok: true, costUsd: pollCostUsd };
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
      provider: 'sora',
      path: 'sora',
      partialFailures: outcomes.filter((r) => !r.ok),
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

function parseSoraPrompts(raw: unknown, expectedCount: number): string[] {
  if (typeof raw === 'string') {
    return raw.length > 0 ? [raw] : [];
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const variants = obj.variants ?? obj.prompts;
    if (Array.isArray(variants)) {
      return variants
        .map((v) => {
          if (typeof v === 'string') return v;
          if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            return typeof o.prompt === 'string' ? o.prompt : '';
          }
          return '';
        })
        .filter((p) => p.length > 0)
        .slice(0, expectedCount);
    }
  }
  return [];
}

void logAuditEvent;
