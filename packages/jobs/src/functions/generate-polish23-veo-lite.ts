/**
 * Polish-23 Commit 3: end-to-end UGC ad worker for the
 * Higgsfield Soul (WaveSpeedAI) + kie.ai Veo 3.1 Lite pipeline.
 *
 * Event: generation/polish23-veo-lite.requested
 *
 * Pipeline (each is an Inngest step.run for retry + caching):
 *   A. Claude ad-spec — { character_lock, segments[N=8] } from
 *      source concept transcription. Persisted to job.metadata.
 *      Wholesale falls back to a Linda-anchored stock ad if
 *      Claude returns un-parseable output (first live test still
 *      exercises end-to-end plumbing).
 *   B. Higgsfield Soul reference PNG via WaveSpeedAI HIGH quality.
 *      One PNG per BATCH — the same URL is threaded into every
 *      Veo clip's imageUrls[] so character consistency is anchored
 *      by first-frame reference.
 *   C. Per-clip Veo Lite loop (8 × 8s clips). Each clip: compose
 *      CHARACTER LOCK prefix → submit → poll → persist kie CDN
 *      URL. Manual 1-retry per segment on non-terminal failure
 *      (the client already handles 429 rate-limits internally).
 *   D. Replicate ffmpeg-concat via Polish-9.12 helper. Feeds
 *      the 8 kie CDN URLs; concat model fetches within the 24-48h
 *      ephemeral window, well inside safe timing.
 *   E. Composite MP4 uploaded to Supabase 'generated-creatives'
 *      bucket (same public-URL path other pipelines use). Insert
 *      generated_creatives row; markJobCompleted.
 *
 * Progress reporting: metadata.polish23_progress patched at each
 * step boundary (5 / 15 / 25 / 25+i/N×60 / 95 / 100). Best-effort
 * — a failed progress patch never fails the pipeline.
 *
 * Character-lock invariants (regression-pinned in the test file):
 *   - character_lock composed ONCE in Step A
 *   - Higgsfield Soul URL generated ONCE in Step B
 *   - Every segment's Veo call uses the identical URL + prefix
 *   - Composite includes 8 clips in submitted order
 */
import { eq } from 'drizzle-orm';
import {
  callClaude,
  checkReplicateConcat,
  composeHiggsfieldSoulReferencePrompt,
  composeVeoLiteSegmentPrompt,
  KIE_VEO_LITE_DEFAULT_USD_PER_CLIP,
  pollKieVeoLite,
  pollWavespeedSoul,
  submitKieVeoLite,
  submitReplicateConcat,
  submitWavespeedSoul,
  WAVESPEED_SOUL_USD_PER_RUN,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';
import {
  AdSpecSchema,
  POLISH23_SEGMENT_COUNT,
  POLISH23_CLIP_SECONDS,
  POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT,
  composePolish23AdSpecUserPrompt,
  fallbackPolish23AdSpec,
  parsePolish23AdSpec,
  type AdSpec,
  type SegmentSpec,
} from '../lib/polish23-claude-adspec-prompt';

console.log(`[jobs.generate-polish23-veo-lite] cold start — POLISH_VERSION=${POLISH_VERSION}`);

const SOUL_POLL_INTERVAL_SECONDS = 5;
const SOUL_POLL_MAX_ATTEMPTS = 24; // ~2 min
const VEO_POLL_INTERVAL_SECONDS = 10;
const VEO_POLL_MAX_ATTEMPTS = 30; // ~5 min per clip
const CONCAT_POLL_INTERVAL_SECONDS = 5;
const CONCAT_POLL_MAX_ATTEMPTS = 36; // ~3 min
const HIGGSFIELD_SEED_IMAGE_URL =
  process.env['POLISH23_HIGGSFIELD_SEED_IMAGE_URL']?.trim() ||
  // WaveSpeedAI's Higgsfield Soul is image-to-image — the seed is a
  // neutral placeholder photo, and the prompt does the heavy lifting.
  // Env override lets the operator swap in a preferred seed.
  'https://storage.googleapis.com/higgsfield-public/seed-neutral.png';

export interface Polish23ProgressStep {
  step: string;
  pct: number;
  at: string;
}

/**
 * Compute per-step progress percentages. Anchored on the operator's
 * spec: 5 / 15 / 25 / 25+(N/8)×60 / 95 / 100.
 */
export function computePolish23Progress(
  step: 'analyze-concept' | 'claude-ad-spec' | 'higgsfield-soul' | 'concat' | 'upload' | 'complete',
  segmentIndex?: number,
): number {
  switch (step) {
    case 'analyze-concept':
      return 5;
    case 'claude-ad-spec':
      return 15;
    case 'higgsfield-soul':
      return 25;
    case 'concat':
      return 95;
    case 'upload':
      return 100;
    case 'complete':
      return 100;
  }
  void segmentIndex;
  return 0;
}

/** Segment progress: 25 + ((segmentIndex + 1) / N) × 60, clamped [25, 85]. */
export function computePolish23SegmentProgress(segmentIndex: number, total: number): number {
  const t = Math.max(1, total);
  const pct = 25 + ((segmentIndex + 1) / t) * 60;
  return Math.max(25, Math.min(85, Math.round(pct)));
}

export const generatePolish23VeoLite = inngest.createFunction(
  {
    id: 'generate-polish23-veo-lite',
    name: 'Polish-23: Higgsfield Soul + kie.ai Veo 3.1 Lite UGC ad',
    // Function-level retry ONE — segment-level manual retry lives
    // inside the loop below.
    retries: 1,
  },
  { event: 'generation/polish23-veo-lite.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    // -------- Load job --------
    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { variantCount: true, metadata: true, conceptIds: true },
      });
    });
    if (!job) {
      await markJobFailed(jobId, userId, 'Job not found', 0);
      return { jobId, mode, generated: 0 };
    }

    // Mark processing + emit initial progress in a single step.
    await step.run('mark-processing', async () => {
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          status: 'processing',
          metadata: {
            ...meta,
            polish23_progress: {
              step: 'analyze-concept',
              pct: computePolish23Progress('analyze-concept'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // -------- Source concept text --------
    const sourceScript = extractSourceScript(job.metadata as Record<string, unknown> | null);

    // -------- Step A: Claude ad-spec --------
    const adSpec = await step.run('claude-ad-spec', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          console.log(`[polish-23-worker] Claude key missing; falling back to stock ad-spec.`);
          return fallbackPolish23AdSpec();
        }
        throw err;
      }
      const r = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt: POLISH23_CLAUDE_ADSPEC_SYSTEM_PROMPT,
        userMessage: composePolish23AdSpecUserPrompt(sourceScript || '(no source script)'),
        maxTokens: 4096,
        generationJobId: jobId,
      });
      if (!r.ok) {
        console.log(`[polish-23-worker] Claude ad-spec failed: ${r.errorMessage}; using fallback.`);
        return fallbackPolish23AdSpec();
      }
      const parsed = parsePolish23AdSpec(r.text);
      if (!parsed) {
        console.log(
          `[polish-23-worker] Claude ad-spec unparseable (first 400 chars: ` +
            `${(r.text ?? '').slice(0, 400)}); using fallback.`,
        );
        return fallbackPolish23AdSpec();
      }
      console.log(
        `[polish-23-worker] Claude ad-spec parsed: character=${parsed.character_lock.name} ` +
          `age=${parsed.character_lock.age} segments=${parsed.segments.length}`,
      );
      return parsed;
    });

    // Persist character_lock + segments to job.metadata + progress bump.
    await step.run('persist-ad-spec', async () => {
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            polish23_progress: {
              step: 'claude-ad-spec',
              pct: computePolish23Progress('claude-ad-spec'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // Warn on word-count drift (informational; worker proceeds).
    for (let i = 0; i < adSpec.segments.length; i++) {
      const wc = adSpec.segments[i]!.dialogue.trim().split(/\s+/).filter(Boolean).length;
      if (wc < 20 || wc > 24) {
        console.log(
          `[polish-23-worker] segment ${i} word-count drift: ${wc} outside [20,24]. ` +
            `Proceeding (worker warn-and-proceed policy).`,
        );
      }
    }

    // -------- Step B: Higgsfield Soul reference PNG --------
    const soulRefUrl = await step.run('higgsfield-soul', async () => {
      const keys = await loadDecryptedKeys(userId, ['wavespeed_ai']);
      const submit = await submitWavespeedSoul({
        userId,
        apiKey: keys.wavespeed_ai!,
        prompt: composeHiggsfieldSoulReferencePrompt(adSpec.character_lock),
        image: HIGGSFIELD_SEED_IMAGE_URL,
        quality: 'high',
        generationJobId: jobId,
      });
      if (!submit.ok || !submit.predictionId) {
        throw new Error(`WaveSpeedAI submit failed: ${submit.errorMessage ?? 'unknown'}`);
      }
      const predictionId = submit.predictionId;
      let outputUrl: string | undefined;
      for (let attempt = 0; attempt < SOUL_POLL_MAX_ATTEMPTS; attempt++) {
        await sleep(SOUL_POLL_INTERVAL_SECONDS * 1000);
        const poll = await pollWavespeedSoul({
          userId,
          apiKey: keys.wavespeed_ai!,
          predictionId,
          generationJobId: jobId,
        });
        if (!poll.ok) {
          throw new Error(`WaveSpeedAI poll failed: ${poll.errorMessage ?? 'unknown'}`);
        }
        if (poll.status === 'failed' || poll.status === 'cancelled') {
          throw new Error(
            `WaveSpeedAI Higgsfield Soul terminal ${poll.status}: ${poll.errorMessage ?? '(no msg)'}`,
          );
        }
        if (poll.status === 'completed') {
          outputUrl = poll.outputUrl;
          break;
        }
      }
      if (!outputUrl) {
        throw new Error(
          `WaveSpeedAI Higgsfield Soul didn't complete within ` +
            `${SOUL_POLL_MAX_ATTEMPTS * SOUL_POLL_INTERVAL_SECONDS}s.`,
        );
      }
      // Re-upload to Supabase for a stable URL kie.ai will fetch.
      const download = await fetch(outputUrl);
      if (!download.ok) {
        throw new Error(`Failed to download Higgsfield Soul PNG: HTTP ${download.status}`);
      }
      const bytes = new Uint8Array(await download.arrayBuffer());
      const base64 = Buffer.from(bytes).toString('base64');
      const upload = await uploadGeneratedImage({
        userId,
        jobId,
        variantIndex: 0,
        imageBase64: base64,
        mimeType: 'image/png',
        filenamePrefix: 'polish23-soul-ref',
      });
      return upload.publicUrl;
    });

    // Persist Soul URL + progress bump.
    await step.run('persist-soul-ref', async () => {
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            higgsfield_soul_ref_url: soulRefUrl,
            polish23_progress: {
              step: 'higgsfield-soul',
              pct: computePolish23Progress('higgsfield-soul'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // -------- Step C: Per-clip Veo Lite loop --------
    const clipUrls: string[] = [];
    for (let i = 0; i < adSpec.segments.length; i++) {
      const segment = adSpec.segments[i]!;
      const clipUrl = await step.run(`veo-clip-${i}`, async () => {
        const keys = await loadDecryptedKeys(userId, ['kie_ai']);
        const { prompt } = composeVeoLiteSegmentPrompt(adSpec.character_lock, {
          segmentIndex: i,
          totalSegments: POLISH23_SEGMENT_COUNT,
          dialogue: segment.dialogue,
          sceneDirection: segment.sceneDirection,
          emotionalBeat: segment.emotionalBeat,
        });
        // Retry-once wrapper.
        for (let attempt = 0; attempt < 2; attempt++) {
          const submit = await submitKieVeoLite({
            userId,
            apiKey: keys.kie_ai!,
            prompt,
            aspectRatio: '9:16',
            imageUrls: [soulRefUrl],
            durationSeconds: POLISH23_CLIP_SECONDS,
            generationJobId: jobId,
          });
          if (!submit.ok || !submit.taskId) {
            if (attempt === 0) {
              console.log(
                `[polish-23-worker] veo-clip-${i} submit attempt 1 failed ` +
                  `(${submit.errorMessage ?? 'unknown'}); retrying.`,
              );
              continue;
            }
            throw new Error(
              `Veo Lite clip ${i} submit failed after retry: ${submit.errorMessage ?? 'unknown'}`,
            );
          }
          const taskId = submit.taskId;
          let outputUrl: string | undefined;
          let failed = false;
          let failMsg = '';
          for (let pollAttempt = 0; pollAttempt < VEO_POLL_MAX_ATTEMPTS; pollAttempt++) {
            await sleep(VEO_POLL_INTERVAL_SECONDS * 1000);
            const poll = await pollKieVeoLite({
              userId,
              apiKey: keys.kie_ai!,
              taskId,
              generationJobId: jobId,
            });
            if (!poll.ok) {
              failed = true;
              failMsg = poll.errorMessage ?? 'poll failed';
              break;
            }
            if (poll.state === 'fail') {
              failed = true;
              failMsg = poll.failMsg ?? poll.failCode ?? 'kie.ai reported fail';
              break;
            }
            if (poll.state === 'success' && poll.outputUrl) {
              outputUrl = poll.outputUrl;
              break;
            }
          }
          if (outputUrl) return outputUrl;
          if (attempt === 0) {
            console.log(
              `[polish-23-worker] veo-clip-${i} poll attempt 1 ended without output ` +
                `(failed=${failed} msg=${failMsg || 'timeout'}); retrying submit.`,
            );
            continue;
          }
          throw new Error(
            `Veo Lite clip ${i} didn't complete after retry: ${failMsg || 'poll timeout'}`,
          );
        }
        throw new Error(`Veo Lite clip ${i} unreachable`);
      });
      clipUrls.push(clipUrl);

      // Best-effort progress patch after each clip.
      await step.run(`persist-clip-${i}-progress`, async () => {
        const db = getDb();
        const meta = (job.metadata ?? {}) as Record<string, unknown>;
        await db
          .update(schema.generationJobs)
          .set({
            metadata: {
              ...meta,
              character_lock: adSpec.character_lock,
              polish23_segments: adSpec.segments,
              higgsfield_soul_ref_url: soulRefUrl,
              polish23_clip_urls: clipUrls,
              polish23_progress: {
                step: `veo-clip-${i}`,
                pct: computePolish23SegmentProgress(i, POLISH23_SEGMENT_COUNT),
                at: new Date().toISOString(),
              },
            },
          })
          .where(eq(schema.generationJobs.id, jobId));
      });
    }

    // -------- Step D: Replicate ffmpeg-concat --------
    const compositeUrl = await step.run('replicate-concat', async () => {
      const keys = await loadDecryptedKeys(userId, ['kling']);
      const submit = await submitReplicateConcat({
        userId,
        apiKey: keys.kling!,
        videoUrls: clipUrls,
        generationJobId: jobId,
      });
      if (!submit.ok || !submit.predictionId) {
        throw new Error(`Replicate concat submit failed: ${submit.errorMessage ?? 'unknown'}`);
      }
      const predictionId = submit.predictionId;
      let compositeVideoUrl: string | undefined;
      for (let attempt = 0; attempt < CONCAT_POLL_MAX_ATTEMPTS; attempt++) {
        await sleep(CONCAT_POLL_INTERVAL_SECONDS * 1000);
        const poll = await checkReplicateConcat({
          userId,
          apiKey: keys.kling!,
          predictionId,
          generationJobId: jobId,
        });
        if (poll.status === 'failed') {
          throw new Error(`Replicate concat failed: ${poll.errorMessage ?? 'unknown'}`);
        }
        if (poll.status === 'completed' && poll.videoUrl) {
          compositeVideoUrl = poll.videoUrl;
          break;
        }
      }
      if (!compositeVideoUrl) {
        throw new Error(
          `Replicate concat didn't complete within ` +
            `${CONCAT_POLL_MAX_ATTEMPTS * CONCAT_POLL_INTERVAL_SECONDS}s.`,
        );
      }
      return compositeVideoUrl;
    });

    // -------- Step E: Upload composite + insert generated_creatives --------
    const uploadedUrl = await step.run('upload-composite', async () => {
      const upload = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: compositeUrl,
        filename: 'polish23-composite',
        // Composite target is 100-150 MB (BCH sizing). Under Vercel
        // Pro's 250 MB serverless memory, but compression pass drops
        // to ~30-50 MB for cheaper Meta upload later.
        compress: true,
      });
      return upload.publicUrl;
    });

    await step.run('insert-generated-creative', async () => {
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        fileUrl: uploadedUrl,
        aspectRatio: '9:16',
        status: 'ready_for_review',
        format: 'polish23_higgsfield_veo_lite',
        generationMetadata: {
          polish_version: POLISH_VERSION,
          character_lock_name: adSpec.character_lock.name,
          higgsfield_soul_ref_url: soulRefUrl,
          clip_urls: clipUrls,
          segment_count: adSpec.segments.length,
        },
      });
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            higgsfield_soul_ref_url: soulRefUrl,
            polish23_clip_urls: clipUrls,
            polish23_composite_url: uploadedUrl,
            polish23_progress: {
              step: 'complete',
              pct: computePolish23Progress('complete'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // Cost math for markJobCompleted:
    //   Claude ($0.02 approx) + Higgsfield Soul HIGH ($0.23) +
    //   8 × Veo Lite ($0.175) + Replicate concat (~$0.15) = ~$1.82
    const totalCost =
      0.02 +
      WAVESPEED_SOUL_USD_PER_RUN.high +
      adSpec.segments.length * KIE_VEO_LITE_DEFAULT_USD_PER_CLIP +
      0.15;

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: 1,
      actualCostUsd: totalCost,
      provider: 'polish23_higgsfield_veo_lite',
    });

    return { jobId, mode, generated: 1, totalCostUsd: totalCost };
  },
);

/**
 * Polish-19.4.2 pattern reused: pull source ad transcription from
 * metadata.analysis.script_transcription. Returns '' when missing —
 * Claude still runs, just with a placeholder message.
 */
export function extractSourceScript(jobMetadata: Record<string, unknown> | null): string {
  if (!jobMetadata) return '';
  const analysis = jobMetadata['analysis'];
  if (!analysis || typeof analysis !== 'object') return '';
  const t = (analysis as Record<string, unknown>)['script_transcription'];
  return typeof t === 'string' ? t : '';
}

/**
 * Sleep helper (swappable in tests via module import mocking). Kept
 * outside step.run bodies so Inngest step caching isn't triggered by
 * sleeps — sleeps are inside the outer poll loops.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export the AdSpec parser types for test coverage.
export { AdSpecSchema, POLISH23_SEGMENT_COUNT, POLISH23_CLIP_SECONDS };
export type { AdSpec, SegmentSpec };
