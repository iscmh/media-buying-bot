import { eq } from 'drizzle-orm';
import {
  callClaude,
  getUniversalUgcMasterPrompt,
  submitKlingVideo,
  checkKlingPrediction,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';

/**
 * Polish-6 item 4: Kling 3.0 multi-clip native lipsync pipeline.
 *
 * Uses the UNIVERSAL_UGC_MASTER_PROMPT (loaded verbatim from .md) as
 * Claude's system prompt. Claude produces a Complete Video Production
 * Manual with character_prompt, set_prompt, and ~16 clips (6s each).
 * Each clip gets a first-frame image gen (deferred to Kling image-to-
 * video with text prompt for now) + a Kling video generation call.
 *
 * PROMPT FIDELITY: the master prompt is loaded via getUniversalUgc-
 * MasterPrompt() from the .md file, never modified or inlined.
 *
 * Cost: ~$4.80 per variant (16 clips × $0.30 Kling each). Surfaced
 * in the cost estimator so the user sees it before submitting.
 */

const CLIPS_PER_VARIANT = 16;
const CLIP_DURATION_SECONDS = 6;
const CONCURRENCY = 3;
const POLL_INTERVAL_SECONDS = 15;
const POLL_MAX_ATTEMPTS = 40;
const MOCK_VIDEO_URL = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

export const generateKlingMultiClipVariants = inngest.createFunction(
  {
    id: 'generate-kling-multi-clip-variants',
    name: 'Generate Kling 3.0 multi-clip variants',
    retries: 1,
  },
  { event: 'generation/kling-multi-clip.requested' },
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

    // mock path
    if (mode === 'mock') {
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount * CLIPS_PER_VARIANT }, (_, i) => ({
          userId,
          generationJobId: jobId,
          fileUrl: MOCK_VIDEO_URL,
          aspectRatio: '9:16' as const,
          status: 'ready_for_review' as const,
          format: 'kling_3_multi_clip',
          clipIndex: i % CLIPS_PER_VARIANT,
          isClipPart: true,
          generationMetadata: { mock: true, clip_index: i % CLIPS_PER_VARIANT },
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
        provider: 'kling',
        path: 'kling-multi-clip',
      });
      return { jobId, mode, generated: variantCount };
    }

    // live: ask Claude to build the production manual
    const manualResult = await step.run('claude-production-manual', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          return { ok: false as const, error: err.message, costUsd: 0 };
        }
        throw err;
      }

      const systemPrompt = getUniversalUgcMasterPrompt();
      const analysis = job?.metadata ?? {};
      const userMessage = JSON.stringify({
        analysis,
        variant_count: variantCount,
        clips_per_variant: CLIPS_PER_VARIANT,
        clip_duration_seconds: CLIP_DURATION_SECONDS,
      });

      const claude = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt,
        userMessage,
        maxTokens: 16384,
        generationJobId: jobId,
      });
      if (!claude.ok) {
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude manual generation failed',
          costUsd: claude.costUsd,
        };
      }
      const parsed = parseProductionManual(claude.json ?? claude.text);
      if (!parsed.ok) {
        return { ok: false as const, error: parsed.error, costUsd: claude.costUsd };
      }
      return { ok: true as const, manual: parsed.manual, costUsd: claude.costUsd };
    });

    if (!manualResult.ok) {
      await markJobFailed(jobId, userId, manualResult.error, manualResult.costUsd);
      return { jobId, mode, generated: 0 };
    }

    const { manual } = manualResult;
    let totalCost = manualResult.costUsd;
    let successCount = 0;

    // For each clip, generate via Kling
    for (let batchStart = 0; batchStart < manual.clips.length; batchStart += CONCURRENCY) {
      const batch = manual.clips.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (clip, idxInBatch) => {
          const clipIndex = batchStart + idxInBatch;

          // Submit Kling with the clip's video prompt
          const submitResult = await step.run(`kling-submit-${clipIndex}`, async () => {
            let keys;
            try {
              keys = await loadDecryptedKeys(userId, ['kling']);
            } catch (err) {
              if (err instanceof MissingProviderKeyError)
                return { ok: false as const, error: err.message };
              throw err;
            }
            const prompt = [
              manual.characterPrompt,
              manual.setPrompt,
              clip.videoPrompt,
              clip.dialogue
                ? `[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "${clip.dialogue}"`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n');

            return submitKlingVideo({
              userId,
              apiKey: keys.kling!,
              prompt,
              durationSeconds: (clip.duration ?? CLIP_DURATION_SECONDS) <= 5 ? 5 : 10,
              aspectRatio: '9:16',
              generationJobId: jobId,
            });
          });

          if (!submitResult.ok || !('predictionId' in submitResult) || !submitResult.predictionId) {
            const err =
              'errorMessage' in submitResult
                ? submitResult.errorMessage
                : 'error' in submitResult
                  ? submitResult.error
                  : 'submit failed';
            return { clipIndex, ok: false, costUsd: 0, error: err };
          }

          // Poll
          let videoUrl: string | undefined;
          let pollCostUsd = 0;
          let pollError: string | undefined;
          for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
            await step.sleep(`kling-poll-${clipIndex}-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
            const tick = await step.run(`kling-check-${clipIndex}-${attempt}`, async () => {
              const keys = await loadDecryptedKeys(userId, ['kling']);
              return checkKlingPrediction({
                userId,
                apiKey: keys.kling!,
                predictionId: submitResult.predictionId!,
                generationJobId: jobId,
              });
            });
            if (tick.status === 'completed') {
              videoUrl = tick.videoUrl;
              pollCostUsd = tick.costUsd;
              break;
            }
            if (tick.status === 'failed') {
              pollError = tick.errorMessage ?? 'Kling clip failed';
              break;
            }
          }

          if (!videoUrl) {
            return {
              clipIndex,
              ok: false,
              costUsd: pollCostUsd,
              error: pollError ?? 'Kling clip timed out',
            };
          }

          // Persist the clip row
          await step.run(`write-clip-${clipIndex}`, async () => {
            const db = getDb();
            await db.insert(schema.generatedCreatives).values({
              userId,
              generationJobId: jobId,
              fileUrl: videoUrl!,
              aspectRatio: '9:16',
              status: 'ready_for_review',
              format: 'kling_3_multi_clip',
              clipIndex,
              isClipPart: true,
              generationMetadata: {
                character_prompt: manual.characterPrompt,
                set_prompt: manual.setPrompt,
                video_prompt: clip.videoPrompt,
                dialogue: clip.dialogue,
                clip_index: clipIndex,
              },
            });
          });

          return { clipIndex, ok: true, costUsd: pollCostUsd };
        }),
      );

      for (const r of results) {
        totalCost += r.costUsd;
        if (r.ok) successCount++;
      }
    }

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: successCount > 0 ? Math.ceil(successCount / CLIPS_PER_VARIANT) : 0,
      actualCostUsd: totalCost,
      provider: 'kling',
      path: 'kling-multi-clip',
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

// =========================================================================
// Parser
// =========================================================================

interface ClipSpec {
  videoPrompt: string;
  dialogue?: string;
  duration?: number;
}

interface ProductionManual {
  characterPrompt: string;
  setPrompt: string;
  clips: ClipSpec[];
}

function parseProductionManual(
  raw: unknown,
): { ok: true; manual: ProductionManual } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    if (typeof raw === 'string') {
      return parseManualFromText(raw);
    }
    return { ok: false, error: 'Claude returned neither JSON nor text for the manual.' };
  }
  const obj = raw as Record<string, unknown>;
  const charPrompt = typeof obj.character_prompt === 'string' ? obj.character_prompt : '';
  const setPrompt = typeof obj.set_prompt === 'string' ? obj.set_prompt : '';
  const clips = parseClipsArray(obj.clips);
  if (clips.length === 0) {
    return { ok: false, error: 'No clips found in production manual.' };
  }
  return {
    ok: true,
    manual: { characterPrompt: charPrompt, setPrompt: setPrompt, clips },
  };
}

function parseManualFromText(
  text: string,
): { ok: true; manual: ProductionManual } | { ok: false; error: string } {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '');
  try {
    const json = JSON.parse(stripped);
    return parseProductionManual(json);
  } catch {
    // Not JSON — try to extract structure from prose
    return {
      ok: true,
      manual: {
        characterPrompt: '',
        setPrompt: '',
        clips: [{ videoPrompt: text.slice(0, 5000) }],
      },
    };
  }
}

function parseClipsArray(raw: unknown): ClipSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ClipSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const videoPrompt =
      typeof c.video_prompt === 'string'
        ? c.video_prompt
        : typeof c.prompt === 'string'
          ? c.prompt
          : '';
    if (!videoPrompt) continue;
    out.push({
      videoPrompt,
      dialogue: typeof c.dialogue === 'string' ? c.dialogue : undefined,
      duration: typeof c.duration === 'number' ? c.duration : undefined,
    });
  }
  return out;
}

void logAuditEvent;
