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
import { NonRetriableError } from 'inngest';
import {
  buildKieVeoRequestBody,
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
  assertAllSegmentsValid,
  coalesceAdSpecWithFallback,
  composePolish23AdSpecUserPrompt,
  diagnosePolish23AdSpecParseFailure,
  type AdSpec,
  type SegmentSpec,
} from '../lib/polish23-claude-adspec-prompt';

console.log(`[jobs.generate-polish23-veo-lite] cold start — POLISH_VERSION=${POLISH_VERSION}`);

/**
 * Polish-23 Commit 3.0.8: conservative prompt-length ceiling. Veo
 * has an undocumented upstream cap; some clips overrun especially
 * with a rich CHARACTER LOCK prefix + longer scene direction. We
 * warn-and-truncate rather than break — a 3000-char prompt still
 * carries the CHARACTER LOCK invariants and dialogue verbatim.
 */
export const POLISH23_PROMPT_MAX_CHARS = 3000;

/**
 * Polish-23 Commit 3.0.8: soft-truncate a composed prompt to the
 * length ceiling with an explicit marker, so kie.ai / Veo can't
 * silently reject an over-long submission. Returns the possibly-
 * shortened prompt AND a flag so the worker's logs surface when
 * the truncation fired.
 */
export function softTruncatePromptForVeo(
  prompt: string,
  maxChars: number = POLISH23_PROMPT_MAX_CHARS,
): { prompt: string; truncated: boolean; originalChars: number } {
  const originalChars = prompt.length;
  if (originalChars <= maxChars) {
    return { prompt, truncated: false, originalChars };
  }
  const marker = `\n[…truncated at ${maxChars} chars; original was ${originalChars}]`;
  const room = Math.max(0, maxChars - marker.length);
  return { prompt: prompt.slice(0, room) + marker, truncated: true, originalChars };
}

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
    // Polish-23 Commit 3.0.2: Step A now returns an enriched shape
    // so the persist step can write durable forensics (raw Claude
    // text excerpt + parse diagnostic + segment fallback tracking)
    // to job.metadata. BCH's stack is new territory; production
    // forensics beat re-running the pipeline to reproduce.
    const stepAResult = await step.run('claude-ad-spec', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          console.warn(
            '[polish-23-worker Step A] Claude key missing — wholesale fallback to Linda anchor + stock ad.',
          );
          const coalesced = coalesceAdSpecWithFallback(null);
          return {
            adSpec: coalesced.adSpec,
            metadataExtras: {
              polish23_claude_raw_text: null,
              polish23_parse_diagnostic: {
                reason: 'claude-key-missing',
                detail: (err as Error).message.slice(0, 400),
              },
              polish23_segments_fallback_used: coalesced.segmentFallbackIndices,
              polish23_wholesale_fallback: coalesced.wholesaleFallback,
            },
          };
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
      const rawText = r.text ?? '';
      const rawTextExcerpt = rawText.slice(0, 4000);
      // Loud-log the FULL raw Claude response (first 4000 chars)
      // BEFORE the parse attempt so any parse failure surfaces the
      // actual response text in Inngest logs immediately.
      console.log(
        `[polish-23-worker Step A] Claude raw response ok=${r.ok} chars=${rawText.length}: ` +
          `${rawTextExcerpt}`,
      );

      if (!r.ok) {
        console.warn(
          `[polish-23-worker Step A] Claude ad-spec call failed (${r.errorMessage}) — ` +
            'wholesale fallback to Linda + stock ad. Full fallback fires: character_lock + segments come paired.',
        );
        const coalesced = coalesceAdSpecWithFallback(null);
        return {
          adSpec: coalesced.adSpec,
          metadataExtras: {
            polish23_claude_raw_text: rawTextExcerpt,
            polish23_parse_diagnostic: {
              reason: 'claude-call-failed',
              detail: (r.errorMessage ?? '').slice(0, 400),
            },
            polish23_segments_fallback_used: coalesced.segmentFallbackIndices,
            polish23_wholesale_fallback: coalesced.wholesaleFallback,
          },
        };
      }

      // Diagnostic parse — names WHY it failed if it does.
      const diag = diagnosePolish23AdSpecParseFailure(rawText);
      const parseDiagnostic = diag.ok
        ? { reason: 'success' as const, detail: null as string | null }
        : { reason: diag.reason, detail: diag.detail ?? null };
      const parsed = diag.ok ? diag.data : null;

      if (!diag.ok) {
        console.warn(
          `[polish-23-worker Step A] Claude ad-spec parse failed: reason=${diag.reason} ` +
            `detail=${diag.detail ?? '(none)'}. Wholesale fallback fires — character_lock + segments come paired.`,
        );
      } else {
        console.log(
          `[polish-23-worker Step A] Claude ad-spec parsed: character=${diag.data.character_lock.name} ` +
            `age=${diag.data.character_lock.age} segments=${diag.data.segments.length}`,
        );
      }

      // Safety-net coalesce runs regardless. In the healthy parse
      // path it's a no-op (identity return). In the failure path it
      // wholesale-fills. In the theoretical partial-drift path it
      // per-index backfills and tracks the offending indices.
      const coalesced = coalesceAdSpecWithFallback(parsed);
      if (coalesced.segmentFallbackIndices.length > 0) {
        console.warn(
          `[polish-23-worker Step A] Safety-net per-segment fallback fired for indices: ` +
            `[${coalesced.segmentFallbackIndices.join(', ')}]. Parser SHOULD have caught this — ` +
            'investigate a schema loosening or in-memory mutation.',
        );
      }

      return {
        adSpec: coalesced.adSpec,
        metadataExtras: {
          polish23_claude_raw_text: rawTextExcerpt,
          polish23_parse_diagnostic: parseDiagnostic,
          polish23_segments_fallback_used: coalesced.segmentFallbackIndices,
          polish23_wholesale_fallback: coalesced.wholesaleFallback,
        },
      };
    });
    const adSpec = stepAResult.adSpec;
    const metadataExtras = stepAResult.metadataExtras;

    // Polish-23 Commit 3.0.1: paranoid triple-check pre-Step-C. The
    // coalescer above already backfills any invalid segment from
    // the fallback, so this should be dead code in every healthy
    // path. Kept as a definitive fail-fast if the fallback itself
    // is somehow corrupt (impossible per test suite).
    try {
      assertAllSegmentsValid(adSpec.segments);
      if (adSpec.character_lock == null || typeof adSpec.character_lock.name !== 'string') {
        throw new Error(
          '[polish-23-worker] AdSpec.character_lock is missing or malformed after coalesce. ' +
            'This should be unreachable — investigate a corrupt fallbackPolish23AdSpec.',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[polish-23-worker Step A → invariant guard] ${msg}`);
      await markJobFailed(jobId, userId, msg, 0);
      return { jobId, mode, generated: 0 };
    }

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
            ...metadataExtras,
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
            ...metadataExtras,
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

    // Polish-23 Commit 3.0.8: soul-ref URL health check. Before we
    // spend Veo credits on 8 clips that all reference this PNG, do
    // a cheap HEAD to confirm kie.ai (or Replicate concat, or any
    // downstream) can fetch it. Non-2xx → NonRetriableError with
    // the URL + status code baked into the message; status also
    // persisted to metadata.polish23_higgsfield_reference_url_status
    // for durable inspection via the operator's SQL query.
    await step.run('soul-ref-health-check', async () => {
      let statusCode: number | null = null;
      let networkError: string | null = null;
      try {
        const head = await fetch(soulRefUrl, { method: 'HEAD' });
        statusCode = head.status;
      } catch (err) {
        networkError = err instanceof Error ? err.message : String(err);
      }
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            ...metadataExtras,
            higgsfield_soul_ref_url: soulRefUrl,
            polish23_higgsfield_reference_url_status:
              statusCode !== null ? String(statusCode) : `network-error: ${networkError}`,
            polish23_progress: {
              step: 'soul-ref-health-check',
              pct: computePolish23Progress('higgsfield-soul'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
      if (networkError !== null) {
        throw new NonRetriableError(
          `Higgsfield Soul reference URL fetch failed (${soulRefUrl}): ${networkError}. ` +
            `Downstream kie.ai + Replicate will fail identically — aborting before Veo credits burn.`,
        );
      }
      if (statusCode === null || statusCode < 200 || statusCode >= 300) {
        throw new NonRetriableError(
          `Higgsfield Soul reference URL is not reachable (${soulRefUrl}, HTTP ${statusCode}). ` +
            `Downstream kie.ai + Replicate will fail identically — aborting before Veo credits burn.`,
        );
      }
    });

    // -------- Step C: Per-clip Veo Lite loop --------
    const clipUrls: string[] = [];
    // Polish-23 Commit 3.0.3: durable forensics — every composed
    // Veo prompt is captured here, then persisted to
    // job.metadata.polish23_composed_prompts on each per-clip
    // progress patch. A future "empty prompt reached kie.ai"
    // report can be verified by reading the metadata row — no
    // more guessing whether the composer or the wire layer was
    // at fault.
    const composedPrompts: Array<{
      segmentIndex: number;
      wordCount: number;
      promptChars: number;
      prompt: string;
    }> = [];
    // Polish-23 Commit 3.0.4: capture the EXACT wire body sent to
    // kie.ai per clip (via buildKieVeoRequestBody, same builder
    // submitKieVeoLite uses internally — zero drift risk). Persisted
    // to metadata.polish23_veo_submit_bodies so a SQL query on the
    // failing row shows the exact shape kie.ai received.
    const veoSubmitBodies: Array<{
      segmentIndex: number;
      body: Record<string, unknown>;
    }> = [];
    for (let i = 0; i < adSpec.segments.length; i++) {
      const segment = adSpec.segments[i]!;
      const composed = composeVeoLiteSegmentPrompt(adSpec.character_lock, {
        segmentIndex: i,
        totalSegments: POLISH23_SEGMENT_COUNT,
        dialogue: segment.dialogue,
        sceneDirection: segment.sceneDirection,
        emotionalBeat: segment.emotionalBeat,
      });
      // Polish-23 Commit 3.0.8: prompt-length instrumentation +
      // soft-truncate. A 3000-char ceiling keeps the CHARACTER
      // LOCK prefix + dialogue intact; anything longer risks
      // silent kie.ai/Veo rejection with no useful error message.
      const truncated = softTruncatePromptForVeo(composed.prompt);
      if (truncated.truncated) {
        console.warn(
          `[polish-23-worker Step C] veo-clip-${i} PROMPT TRUNCATED: ` +
            `original=${truncated.originalChars} chars, sent=${truncated.prompt.length} chars. ` +
            `Investigate composer output growth if this fires often.`,
        );
      }
      const composedPromptRecord = {
        segmentIndex: i,
        wordCount: composed.wordCountCheck.wordCount,
        promptChars: truncated.prompt.length,
        originalChars: truncated.originalChars,
        truncated: truncated.truncated,
        prompt: truncated.prompt.slice(0, 3000),
      };
      composedPrompts.push(composedPromptRecord);
      console.log(
        `[polish-23-worker Step C] veo-clip-${i} composed prompt ` +
          `chars=${truncated.prompt.length} (original=${truncated.originalChars}) ` +
          `truncated=${truncated.truncated} ` +
          `words=${composed.wordCountCheck.wordCount}: ${truncated.prompt.slice(0, 3000)}`,
      );
      if (composed.prompt.trim().length === 0) {
        console.error(
          `[polish-23-worker Step C] veo-clip-${i} COMPOSER PRODUCED EMPTY PROMPT — this should be impossible. ` +
            `Aborting job before Veo credits are spent.`,
        );
        await markJobFailed(
          jobId,
          userId,
          `composeVeoLiteSegmentPrompt returned empty for segment ${i} — investigate composer regression.`,
          0,
        );
        return { jobId, mode, generated: 0 };
      }

      // Polish-23 Commit 3.0.5: build + push the wire body OUTSIDE
      // the veo-clip step so the outer-closure array is populated
      // deterministically BEFORE the risky submit step runs. Prior
      // to this, capturedBody was pushed inside step.run — when the
      // step threw, the in-memory push survived but the persist
      // step that would have written it downstream never ran.
      const capturedBody = buildKieVeoRequestBody({
        userId,
        apiKey: '',
        prompt: truncated.prompt,
        aspectRatio: '9:16',
        imageUrls: [soulRefUrl],
        durationSeconds: POLISH23_CLIP_SECONDS,
        generationJobId: jobId,
      });
      veoSubmitBodies.push({ segmentIndex: i, body: capturedBody });
      console.error(
        `[polish-23-worker Step C] veo-clip-${i} submit body (stderr fallback): ` +
          `${JSON.stringify(capturedBody).slice(0, 500)}`,
      );

      // Polish-23 Commit 3.0.5: persist forensics BEFORE the risky
      // submit. If veo-clip-i throws, the DB write already committed
      // — the operator's SQL query returns the actual prompt +
      // wire body regardless of downstream failure. Own step.run so
      // Inngest caches it and retries don't re-write on function-
      // level retry.
      const composedPromptsSoFar = composedPrompts.slice();
      const veoSubmitBodiesSoFar = veoSubmitBodies.slice();
      await step.run(`persist-clip-${i}-forensics`, async () => {
        const db = getDb();
        const meta = (job.metadata ?? {}) as Record<string, unknown>;
        await db
          .update(schema.generationJobs)
          .set({
            metadata: {
              ...meta,
              character_lock: adSpec.character_lock,
              polish23_segments: adSpec.segments,
              ...metadataExtras,
              higgsfield_soul_ref_url: soulRefUrl,
              polish23_clip_urls: clipUrls,
              polish23_composed_prompts: composedPromptsSoFar,
              polish23_veo_submit_bodies: veoSubmitBodiesSoFar,
              polish23_progress: {
                step: `veo-clip-${i}-forensics`,
                pct: computePolish23SegmentProgress(i, POLISH23_SEGMENT_COUNT),
                at: new Date().toISOString(),
              },
            },
          })
          .where(eq(schema.generationJobs.id, jobId));
      });

      let clipUrl: string;
      try {
        clipUrl = await step.run(`veo-clip-${i}`, async () => {
          const keys = await loadDecryptedKeys(userId, ['kie_ai']);
          const prompt = truncated.prompt;
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
              // Polish-23 Commit 3.0.8: persist kie.ai's full raw
              // error response to job.metadata BEFORE throwing so
              // the operator's SQL query surfaces the structured
              // rejection detail (validator field name, code, etc.)
              // without waiting on Inngest logs. Idempotent write —
              // safe to re-execute on step retry.
              try {
                const db = getDb();
                const meta = (job.metadata ?? {}) as Record<string, unknown>;
                await db
                  .update(schema.generationJobs)
                  .set({
                    metadata: {
                      ...meta,
                      polish23_veo_error_response: {
                        segmentIndex: i,
                        attempt,
                        errorMessage: submit.errorMessage,
                        errorKind: submit.errorKind,
                        rawErrorBody: submit.rawErrorBody,
                        at: new Date().toISOString(),
                      },
                    },
                  })
                  .where(eq(schema.generationJobs.id, jobId));
              } catch (persistErr) {
                console.error(
                  `[polish-23-worker Step C] veo-clip-${i} kie-error persist failed: ` +
                    `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                );
              }
              // Polish-23 Commit 3.0.6: terminal errors (400 / auth /
              // balance / shape drift / "Please enter prompt")
              // skip the retry-once entirely AND throw
              // NonRetriableError so Inngest doesn't retry the whole
              // function either. Genuine transient errors (429/5xx)
              // fall through the retry-once and — if still failing —
              // throw a regular Error so Inngest's function-level
              // retry takes one more shot.
              if (submit.errorKind === 'terminal') {
                throw new NonRetriableError(
                  `Veo Lite clip ${i} submit terminal failure: ${submit.errorMessage ?? 'unknown'}`,
                );
              }
              if (attempt === 0) {
                console.log(
                  `[polish-23-worker] veo-clip-${i} submit attempt 1 failed (transient) ` +
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
                // Poll transport failure — terminal shortcut when
                // the client says so, otherwise let the outer retry
                // -once fall through to a fresh submit.
                if (poll.errorKind === 'terminal') {
                  throw new NonRetriableError(
                    `Veo Lite clip ${i} poll terminal failure: ${poll.errorMessage ?? 'unknown'}`,
                  );
                }
                failed = true;
                failMsg = poll.errorMessage ?? 'poll failed';
                break;
              }
              if (poll.state === 'fail') {
                // Polish-23 Commit 3.0.6: kie.ai state='fail' is a
                // definitive judgment — retrying the same clip with
                // the same input burns credits for zero gain. Skip
                // the retry-once + throw NonRetriableError.
                throw new NonRetriableError(
                  `Veo Lite clip ${i} kie.ai reported fail: ` +
                    `${poll.failMsg ?? poll.failCode ?? 'no reason given'}`,
                );
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
      } catch (err) {
        // Polish-23 Commit 3.0.5: catch the veo-clip step failure so
        // the job status ends as 'failed' (not stuck at 'processing')
        // AND the forensics we already persisted stay durable. The
        // persist-clip-i-forensics step above ALREADY wrote
        // composedPrompts + veoSubmitBodies through i to metadata,
        // so the operator's SQL query returns real data.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[polish-23-worker Step C] veo-clip-${i} FAILED after all retries: ${msg}. ` +
            `Forensics through segment ${i} are persisted in metadata. ` +
            `Ending job as failed (was previously stuck at status='processing').`,
        );
        await markJobFailed(jobId, userId, msg, 0);
        return { jobId, mode, generated: 0 };
      }
      clipUrls.push(clipUrl);

      // Best-effort progress patch after each clip.
      // Polish-23 Commit 3.0.3: also persist the durable
      // composed-prompt forensics + Commit-3.0.2 metadataExtras
      // (the earlier commit missed this persist site due to a
      // different indentation level, so previous runs dropped
      // metadataExtras between higgsfield-soul persist and the
      // final insert-generated-creative persist).
      const composedPromptsSnapshot = composedPrompts.slice();
      const veoSubmitBodiesSnapshot = veoSubmitBodies.slice();
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
              ...metadataExtras,
              higgsfield_soul_ref_url: soulRefUrl,
              polish23_clip_urls: clipUrls,
              polish23_composed_prompts: composedPromptsSnapshot,
              polish23_veo_submit_bodies: veoSubmitBodiesSnapshot,
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
            ...metadataExtras,
            higgsfield_soul_ref_url: soulRefUrl,
            polish23_clip_urls: clipUrls,
            polish23_composed_prompts: composedPrompts,
            polish23_veo_submit_bodies: veoSubmitBodies,
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
