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
// Polish-9.6: poll ceiling = POLL_INTERVAL × POLL_MAX_ATTEMPTS. Default
// 15s × 40 = 600s = 10 min per clip (matches REPLICATE_POLL_TIMEOUT_MS
// spec ceiling). REPLICATE_POLL_TIMEOUT_MS env overrides the ceiling
// without touching the interval — useful when Replicate gets slow.
const REPLICATE_POLL_TIMEOUT_MS = Number(process.env.REPLICATE_POLL_TIMEOUT_MS) || 600_000;
const POLL_INTERVAL_SECONDS = 15;
const POLL_MAX_ATTEMPTS = Math.ceil(REPLICATE_POLL_TIMEOUT_MS / 1000 / POLL_INTERVAL_SECONDS);
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
        console.log(`[kling-manual] Claude call failed: ${claude.errorMessage ?? 'unknown'}`);
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude manual generation failed',
          costUsd: claude.costUsd,
        };
      }
      // Polish-9.7: capture raw output for diagnostics. The parser used
      // to silently fall back to a single bad clip on non-JSON; now it
      // hard-fails with a clear error and we log the first 1000 chars
      // so the Inngest dashboard shows what Claude actually returned.
      console.log(
        `[kling-manual] Claude returned ${(claude.text ?? '').length} chars; ` +
          `first 1000: ${(claude.text ?? '').slice(0, 1000)}`,
      );
      const parsed = parseProductionManual(claude.json ?? claude.text);
      if (!parsed.ok) {
        console.log(`[kling-manual] parse failed: ${parsed.error}`);
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
            console.log(`[kling-clip-${clipIndex}] submit failed: ${err}`);
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
            const err =
              pollError ??
              `Kling clip timed out after ${POLL_MAX_ATTEMPTS} polls ` +
                `(${POLL_INTERVAL_SECONDS}s interval = ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS) / 60} min ceiling)`;
            console.log(`[kling-clip-${clipIndex}] ${err}`);
            return {
              clipIndex,
              ok: false,
              costUsd: pollCostUsd,
              error: err,
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

    // Polish-9.7: fail-fast when zero clips succeed. The previous code
    // marked the job 'completed' with 0 generated_creatives rows, which
    // looked like a successful run in the UI but produced nothing.
    const outcome = decideKlingJobOutcome({
      successCount,
      totalClips: manual.clips.length,
      clipsPerVariant: CLIPS_PER_VARIANT,
    });
    if (outcome.kind === 'fail') {
      console.log(`[kling-job] 0 of ${manual.clips.length} clips succeeded — marking job failed`);
      await markJobFailed(jobId, userId, outcome.error, totalCost);
      return { jobId, mode, generated: 0, totalCost };
    }

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: outcome.variantCount,
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

/**
 * Polish-9.7: pure decision for whether a finished clip loop should
 * mark the job 'failed' (zero successes) or 'completed' (at least one).
 * Exported for unit tests. Mirrored inline in the Inngest function so
 * step boundaries don't need re-mapping.
 */
export function decideKlingJobOutcome(input: {
  successCount: number;
  totalClips: number;
  clipsPerVariant: number;
}): { kind: 'fail'; error: string } | { kind: 'complete'; variantCount: number } {
  if (input.successCount === 0) {
    return {
      kind: 'fail',
      error: `All ${input.totalClips} clips failed. Check per-clip errors in the Inngest run.`,
    };
  }
  return {
    kind: 'complete',
    variantCount: Math.ceil(input.successCount / input.clipsPerVariant),
  };
}

// Polish-9.7: exported for unit tests covering the no-fallback path.
export function parseProductionManual(
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
    // Polish-9.7: hard-fail with the raw output so the Inngest dashboard
    // shows EXACTLY what Claude returned. The previous silent fallback
    // built one bad clip with prose as the prompt, then submitted it to
    // Kling where it crashed without diagnostic.
    return {
      ok: false,
      error:
        'Claude returned non-JSON manual. Expected structured JSON with ' +
        '{ character_prompt, set_prompt, clips: [...] }. First 500 chars: ' +
        text.slice(0, 500),
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
