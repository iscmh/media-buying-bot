import { NonRetriableError } from 'inngest';
import { eq } from 'drizzle-orm';
import {
  OpenaiContentPolicyError,
  OpenaiInsufficientFundsError,
  OpenaiInvalidImageError,
  OpenaiRateLimitError,
  OpenaiTimeoutError,
  OpenaiTransientError,
  callClaude,
  redactOpenaiApiKey,
  submitOpenaiImageGeneration,
  type OpenaiImageQuality,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { STATIC_WINNER_IMPORT_SYSTEM_PROMPT } from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { downloadAsBase64, uploadGeneratedImage } from '../lib/storage';
import { parseVariantsArray, type ClaudeCopyVariant } from './generate-static-variants';

/**
 * Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad worker.
 *
 * Mirrors the Gemini-based generate-static-variants worker but
 * swaps the image-gen call for OpenAI's /v1/images/edits endpoint
 * (reference-image-anchored). Discipline patterns lifted from the
 * Polish-25 MakeUGC worker:
 *
 *   - Every phase boundary is its own step.run so Inngest retries
 *     hit fine-grained boundaries, and metadata.static_openai_progress
 *     persists at each transition so the run-detail timeline reflects
 *     real worker state (see apps/web/app/runs/[id]/job-timeline.tsx
 *     — reads polish25_progress today; will read static_openai_progress
 *     from a matching timeline helper).
 *   - Persist-before-throw: failure paths write markJobFailed + the
 *     current progress marker BEFORE throwing NonRetriableError so
 *     forensic SQL can trace what step blew up.
 *   - OpenAI typed errors surface as NonRetriableError (moderation,
 *     billing, invalid image) OR let step.run retry (429 / 5xx /
 *     network — thrown up as regular Errors).
 *
 * The mock path prints synthetic rows for /admin/test-actions to
 * exercise the same job-review UI without spending real money.
 */

const CONCURRENCY = 5;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Static_openai_progress step names — mirrored on the frontend
 * timeline helper. Any rename here MUST land in job-timeline.tsx
 * `POLISH25_STEP_TO_TIMELINE` (or its static-openai twin) on the
 * same commit.
 */
type StaticOpenaiProgressStep =
  | 'mark-processing'
  | 'copy-rewritten'
  | 'reference-loaded'
  | 'images-rendering'
  | 'images-uploaded'
  | 'complete';

async function patchMetadata(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const row = await db.query.generationJobs.findFirst({
    where: eq(schema.generationJobs.id, jobId),
    columns: { metadata: true },
  });
  const existing = (row?.metadata ?? {}) as Record<string, unknown>;
  await db
    .update(schema.generationJobs)
    .set({ metadata: { ...existing, ...patch } })
    .where(eq(schema.generationJobs.id, jobId));
}

async function markProgress(
  jobId: string,
  step: StaticOpenaiProgressStep,
  pct: number,
): Promise<void> {
  await patchMetadata(jobId, {
    static_openai_progress: { step, pct, at: nowIso() },
  });
}

export const generateStaticOpenaiImageVariants = inngest.createFunction(
  {
    id: 'generate-static-openai-image-variants',
    name: 'Polish-25.3: OpenAI gpt-image-2 static ad',
    retries: 1,
    // Polish-25.8 Commit 55: after Inngest exhausts retries, flip
    // generation_jobs.status='failed' so the job doesn't sit at
    // 'processing' forever when the whole function crashes.
    onFailure: logInngestFailure,
  },
  { event: 'generation/static-openai.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    // -------- Step A: load job --------
    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: {
          variantCount: true,
          intensity: true,
          conceptIds: true,
          metadata: true,
        },
      });
    });
    if (!job) {
      await markJobFailed(jobId, userId, 'Job not found', 0);
      return { jobId, mode, generated: 0 };
    }

    const variantCount = job.variantCount ?? 0;
    const intensity = (job.intensity ?? 'medium') as 'small' | 'medium' | 'big';
    const conceptId = job.conceptIds?.[0];
    // Quality tier is stashed on job.metadata by the create-job
    // action. Fallback to 'medium' matches the form default so the
    // cost estimate + worker never drift.
    const quality: OpenaiImageQuality = extractQuality(job.metadata);

    if (variantCount <= 0 || !conceptId) {
      await markJobFailed(jobId, userId, 'variant_count or concept_id missing', 0);
      return { jobId, mode, generated: 0 };
    }

    // -------- Step B: mark processing --------
    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
      await markProgress(jobId, 'mark-processing', 5);
    });

    // -------- mock path --------
    if (mode === 'mock') {
      await step.sleep('mock-image-gen', '2s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount }, (_, i) => ({
          userId,
          generationJobId: jobId,
          fileUrl: `https://placehold.co/1024x1024/png?text=OpenAI+Variant+${i + 1}`,
          imageStoragePath: null,
          headline: `Mock headline ${i}`,
          primaryText: `Mock primary text for OpenAI variant ${i}.`,
          description: `Mock description ${i}`,
          hookVariantIndex: i,
          bodyVariantIndex: i,
          ctaVariantIndex: i,
          aspectRatio: '1:1' as const,
          status: 'ready_for_review' as const,
          format: 'static_openai_image',
          generationMetadata: { mock: true, variant_index: i, quality },
        }));
        await db.insert(schema.generatedCreatives).values(rows);
      });
      await markProgress(jobId, 'complete', 100);
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount,
        actualCostUsd: 0,
      });
      return { jobId, mode, generated: variantCount };
    }

    // -------- Step C: Claude copy rewrite --------
    const claudeResult = await step.run('claude-copy-variants', async () => {
      let apiKey: string;
      try {
        const keys = await loadDecryptedKeys(userId, ['claude']);
        apiKey = keys.claude!;
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          return { ok: false as const, error: err.message, costUsd: 0 };
        }
        throw err;
      }

      const db = getDb();
      const concept = await db.query.concepts.findFirst({
        where: eq(schema.concepts.id, conceptId),
        columns: {
          staticHeadline: true,
          staticPrimaryText: true,
          staticDescription: true,
          nicheTag: true,
          offerUrl: true,
        },
      });
      if (!concept) {
        return { ok: false as const, error: 'Concept not found', costUsd: 0 };
      }

      const userMessage = JSON.stringify({
        original_ad: {
          headline: concept.staticHeadline,
          primary_text: concept.staticPrimaryText,
          description: concept.staticDescription,
        },
        niche: concept.nicheTag,
        offer_url: concept.offerUrl,
        intensity,
        variant_count: variantCount,
      });

      const claude = await callClaude({
        userId,
        apiKey,
        systemPrompt: STATIC_WINNER_IMPORT_SYSTEM_PROMPT,
        userMessage,
        maxTokens: 4096,
        generationJobId: jobId,
      });

      if (!claude.ok) {
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude failed',
          costUsd: claude.costUsd,
        };
      }

      const parsed = parseVariantsArray(claude.json, variantCount);
      if (!parsed.ok) {
        return { ok: false as const, error: parsed.error, costUsd: claude.costUsd };
      }

      return {
        ok: true as const,
        variants: parsed.variants,
        costUsd: claude.costUsd,
      };
    });

    if (!claudeResult.ok) {
      await markJobFailed(jobId, userId, claudeResult.error, claudeResult.costUsd);
      return { jobId, mode, generated: 0 };
    }
    await step.run('mark-copy-rewritten', () => markProgress(jobId, 'copy-rewritten', 30));

    // -------- Step D: load reference image --------
    // Loaded ONCE for the batch (not per variant) — the base64 blob
    // is small enough to thread through step.run boundaries as a
    // step return value.
    const reference = await step.run('load-source-image', async () => {
      const db = getDb();
      const concept = await db.query.concepts.findFirst({
        where: eq(schema.concepts.id, conceptId),
        columns: { fileUrl: true },
      });
      if (!concept?.fileUrl) {
        return { ok: false as const, error: 'Concept reference image missing' };
      }
      try {
        const bytes = await downloadAsBase64({
          bucket: 'concepts',
          path: concept.fileUrl,
          maxBytes: 10 * 1024 * 1024,
        });
        return {
          ok: true as const,
          base64: bytes.base64,
          mimeType: bytes.mimeType,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    if (!reference.ok) {
      await markJobFailed(jobId, userId, reference.error, claudeResult.costUsd);
      return { jobId, mode, generated: 0 };
    }
    await step.run('mark-reference-loaded', () => markProgress(jobId, 'reference-loaded', 45));

    // -------- Step E: OpenAI image variants (parallel batches) --------
    await step.run('mark-images-rendering', () => markProgress(jobId, 'images-rendering', 55));

    const variants = claudeResult.variants;
    const imageOutcomes: Array<{
      index: number;
      ok: boolean;
      costUsd: number;
      error?: string;
    }> = [];

    for (let batchStart = 0; batchStart < variants.length; batchStart += CONCURRENCY) {
      const batch = variants.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.all(
        batch.map((variant, idxInBatch) => {
          const variantIndex = batchStart + idxInBatch;
          return step.run(`openai-image-${variantIndex}`, () =>
            renderOneOpenaiVariant({
              userId,
              jobId,
              variantIndex,
              copy: variant,
              quality,
              referenceBase64: reference.base64,
              referenceMimeType: reference.mimeType,
            }),
          );
        }),
      );
      imageOutcomes.push(...results);
    }

    await step.run('mark-images-uploaded', () => markProgress(jobId, 'images-uploaded', 95));

    const totalCost = claudeResult.costUsd + imageOutcomes.reduce((sum, o) => sum + o.costUsd, 0);
    const successCount = imageOutcomes.filter((o) => o.ok).length;

    await markProgress(jobId, 'complete', 100);
    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: successCount,
      actualCostUsd: totalCost,
      partialFailures: imageOutcomes.filter((o) => !o.ok),
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

function extractQuality(metadata: unknown): OpenaiImageQuality {
  if (!metadata || typeof metadata !== 'object') return 'medium';
  const q = (metadata as Record<string, unknown>)['static_openai_quality'];
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  return 'medium';
}

async function renderOneOpenaiVariant(input: {
  userId: string;
  jobId: string;
  variantIndex: number;
  copy: ClaudeCopyVariant;
  quality: OpenaiImageQuality;
  referenceBase64: string;
  referenceMimeType: string;
}): Promise<{ index: number; ok: boolean; costUsd: number; error?: string }> {
  const db = getDb();

  let apiKey: string;
  try {
    const keys = await loadDecryptedKeys(input.userId, ['openai']);
    apiKey = keys.openai!;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[static-openai] variant=${input.variantIndex} key-load-fail: ${msg}`);
    return { index: input.variantIndex, ok: false, costUsd: 0, error: msg };
  }

  const prompt = renderOpenaiEditPrompt(input.copy, input.variantIndex);

  let image;
  try {
    image = await submitOpenaiImageGeneration({
      apiKey,
      prompt,
      quality: input.quality,
      size: '1024x1024',
      referenceImageBase64: input.referenceBase64,
      referenceImageMimeType: input.referenceMimeType,
      userId: input.userId,
      generationJobId: input.jobId,
    });
  } catch (err) {
    // Typed errors → NonRetriable to surface immediately in the
    // Inngest UI. All persist the failure row first so the review
    // page shows what went wrong per-variant.
    if (
      err instanceof OpenaiContentPolicyError ||
      err instanceof OpenaiInsufficientFundsError ||
      err instanceof OpenaiInvalidImageError
    ) {
      await db.insert(schema.generatedCreatives).values({
        userId: input.userId,
        generationJobId: input.jobId,
        fileUrl: '',
        imageStoragePath: null,
        headline: input.copy.headline,
        primaryText: input.copy.primary_text,
        description: input.copy.description ?? null,
        hookVariantIndex: input.variantIndex,
        bodyVariantIndex: input.variantIndex,
        ctaVariantIndex: input.variantIndex,
        aspectRatio: '1:1',
        status: 'rejected',
        format: 'static_openai_image',
        generationMetadata: {
          variant_index: input.variantIndex,
          error: err.message,
          error_kind: err.kind,
          status_code: err.statusCode,
          key_last4: redactOpenaiApiKey(apiKey),
        },
      });
      throw new NonRetriableError(err.message);
    }
    // 18b-hotfix: rate-limit + transient 5xx bubble → step.run
    // retries. gpt-image-2 High routinely 504s during 15-30s
    // generations; the retry lands on a healthy edge node.
    if (err instanceof OpenaiRateLimitError) {
      console.log(`[static-openai] variant=${input.variantIndex} rate-limit — throwing for retry`);
      throw err;
    }
    if (err instanceof OpenaiTransientError) {
      console.log(
        `[static-openai] variant=${input.variantIndex} transient status=${err.statusCode} — throwing for retry`,
      );
      throw err;
    }
    // Commit 19: AbortSignal.timeout() lands here. Prior versions
    // caught it inside the client and returned { ok: false }, which
    // step.run did NOT retry — operator hit "operation was aborted
    // due to timeout" on every Static-ad variant with no retry.
    // Now the client throws OpenaiTimeoutError; worker bubbles it
    // → step.run re-fires (function-level retries: 1). Effective
    // budget per variant = 2× per-quality timeout.
    if (err instanceof OpenaiTimeoutError) {
      console.log(
        `[static-openai] variant=${input.variantIndex} timeout timeout_ms=${err.timeoutMs} — throwing for retry`,
      );
      throw err;
    }
    throw err;
  }

  if (!image.ok || !image.imageBase64) {
    await db.insert(schema.generatedCreatives).values({
      userId: input.userId,
      generationJobId: input.jobId,
      fileUrl: '',
      imageStoragePath: null,
      headline: input.copy.headline,
      primaryText: input.copy.primary_text,
      description: input.copy.description ?? null,
      hookVariantIndex: input.variantIndex,
      bodyVariantIndex: input.variantIndex,
      ctaVariantIndex: input.variantIndex,
      aspectRatio: '1:1',
      status: 'rejected',
      format: 'static_openai_image',
      generationMetadata: {
        variant_index: input.variantIndex,
        error: image.errorMessage ?? 'OpenAI returned no data',
        status_code: image.statusCode,
      },
    });
    return {
      index: input.variantIndex,
      ok: false,
      costUsd: image.costUsd,
      error: image.errorMessage ?? 'OpenAI returned no data',
    };
  }

  let storagePath: string;
  let publicUrl: string;
  try {
    const upload = await uploadGeneratedImage({
      userId: input.userId,
      jobId: input.jobId,
      variantIndex: input.variantIndex,
      imageBase64: image.imageBase64,
      mimeType: image.imageMimeType ?? 'image/png',
    });
    storagePath = upload.path;
    publicUrl = upload.publicUrl;
  } catch (err) {
    return {
      index: input.variantIndex,
      ok: false,
      costUsd: image.costUsd,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await db.insert(schema.generatedCreatives).values({
    userId: input.userId,
    generationJobId: input.jobId,
    fileUrl: publicUrl,
    imageStoragePath: storagePath,
    headline: input.copy.headline,
    primaryText: input.copy.primary_text,
    description: input.copy.description ?? null,
    hookVariantIndex: input.variantIndex,
    bodyVariantIndex: input.variantIndex,
    ctaVariantIndex: input.variantIndex,
    aspectRatio: '1:1',
    status: 'ready_for_review',
    format: 'static_openai_image',
    generationMetadata: {
      variant_index: input.variantIndex,
      claude_rationale: input.copy.rationale ?? null,
      openai_prompt_used: prompt,
      openai_quality: input.quality,
      openai_revised_prompt: image.revisedPrompt ?? null,
      intensity_level: input.copy.intensity_level,
    },
  });

  return { index: input.variantIndex, ok: true, costUsd: image.costUsd };
}

/**
 * Compose the /v1/images/edits prompt. Frames the call as an
 * overlay-copy replacement + persona-consistent visual variation.
 * Similar spirit to the Gemini Nano Banana system instruction —
 * OpenAI's edits endpoint respects "edit the image" framing.
 */
function renderOpenaiEditPrompt(copy: ClaudeCopyVariant, variantIndex: number): string {
  const secondary = copy.primary_text.slice(0, 160);
  const intensityHint =
    copy.intensity_level === 'small'
      ? 'Minimal visual change — keep composition + persona + colors identical, only swap the overlay text.'
      : copy.intensity_level === 'medium'
        ? 'Moderate visual shift — same persona and setting, allow small palette or framing adjustments.'
        : 'Fresh persona or angle for the same offer — keep the product visible and the mockup style consistent.';
  return `You are editing a winning static ad creative. Replace its overlay text with the exact copy below and apply the persona shift described.

REQUIREMENTS
- Replace overlay text EXACTLY as given (no paraphrasing, no invented words).
- Preserve the mockup style (screenshot / notification / iPhone popup / product hero — match whatever the reference shows).
- Text fits inside the visible canvas with at least 8% safe margin from all edges. If longer than the original, scale font DOWN.
- Keep the offer / brand / product recognizable.

PRIMARY OVERLAY (headline): ${JSON.stringify(copy.headline)}
SECONDARY OVERLAY (body): ${JSON.stringify(secondary)}

VARIATION INTENSITY: ${copy.intensity_level} — ${intensityHint}
${copy.rationale ? `RATIONALE: ${copy.rationale}` : ''}

Variant index: ${variantIndex}`;
}

async function markJobFailed(
  jobId: string,
  userId: string,
  error: string,
  costUsd: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.generationJobs)
    .set({
      status: 'failed',
      errorMessage: error,
      actualCostUsd: costUsd.toFixed(4),
    })
    .where(eq(schema.generationJobs.id, jobId));
  await logAuditEvent({
    userId,
    eventType: 'generation_job_completed',
    eventData: {
      job_id: jobId,
      ok: false,
      error,
      cost_usd: costUsd,
      pipeline: 'static_openai_image',
    },
  });
}

async function markJobCompleted(input: {
  jobId: string;
  userId: string;
  mode: 'mock' | 'live';
  startedAt: number;
  variantCount: number;
  actualCostUsd: number;
  partialFailures?: Array<{ index: number; error?: string }>;
}): Promise<void> {
  const db = getDb();
  const durationMs = Date.now() - input.startedAt;
  await db
    .update(schema.generationJobs)
    .set({
      status: 'completed',
      completedAt: new Date(),
      generatedCreativeCount: input.variantCount,
      actualCostUsd: input.actualCostUsd.toFixed(4),
    })
    .where(eq(schema.generationJobs.id, input.jobId));
  await logAuditEvent({
    userId: input.userId,
    eventType: 'generation_job_completed',
    eventData: {
      job_id: input.jobId,
      variant_count: input.variantCount,
      mode: input.mode,
      mock: input.mode === 'mock',
      duration_ms: durationMs,
      pipeline: 'static_openai_image',
      cost_usd: input.actualCostUsd,
      partial_failures: input.partialFailures ?? [],
    },
  });
}
