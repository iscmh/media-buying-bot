import { eq } from 'drizzle-orm';
import { callClaude, callGeminiImage, describeGeminiUploadError } from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import {
  NANO_BANANA_CLONING_PROMPT_TEMPLATE,
  STATIC_WINNER_IMPORT_SYSTEM_PROMPT,
} from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { wrapWithPsywarCorpus } from '../lib/polish28-psywar-corpus';
import { downloadAsBase64, uploadGeneratedImage } from '../lib/storage';

/**
 * Phase 3b: real static variant generator. Mock path preserved for the
 * Phase 3a flow.
 *
 * Live pipeline:
 *   1. mark processing
 *   2. (decrypt keys + load concept context + Claude copy call) — single
 *      step.run that returns the parsed variants array
 *   3. for each variant in batches of 5: Gemini Image call → upload to
 *      Supabase Storage → INSERT generated_creatives row. Each variant has
 *      its own retry boundary via step.run; failures don't cascade.
 *   4. roll up actual_cost_usd, mark completed (or partially completed)
 */

const CONCURRENCY = 5;
const MOCK_SIZES = ['1080x1080', '1080x1350', '1080x1920'] as const;

export const generateStaticVariants = inngest.createFunction(
  {
    id: 'generate-static-variants',
    name: 'Generate static variants',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/static.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: {
          variantCount: true,
          intensity: true,
          conceptIds: true,
          format: true,
          pickedPipeline: true,
        },
      });
    });

    // Polish-25.8 Commit 56: pipeline guard against wrong-worker
    // dispatch. Real cause of the orphan-row bug: a legacy fan-out
    // path fired generation/static.requested against a
    // polish25_makeugc job, so this worker wrote a static_gemini_
    // image creative + failure row onto a UGC video job. Guard
    // refuses to run if the job's own format tag doesn't map to a
    // static-gemini pipeline. Any bogus dispatch fails cleanly with
    // an audit log entry instead of writing an orphan row.
    if (job) {
      const format = job.format ?? '';
      const picked = job.pickedPipeline ?? '';
      const looksStaticGemini =
        format.startsWith('static_gemini') ||
        format.startsWith('nano_banana') ||
        picked.startsWith('static_gemini') ||
        picked.startsWith('nano_banana') ||
        // Legacy default when the form didn't stamp a format.
        (!format && !picked);
      if (!looksStaticGemini) {
        console.log(
          `[static-variants] refusing dispatch job=${jobId} format=${format} picked=${picked} — not a static-gemini pipeline`,
        );
        await logAuditEvent({
          userId,
          eventType: 'generation_job_dispatch_refused',
          eventData: {
            job_id: jobId,
            worker: 'generate-static-variants',
            reason: 'format_mismatch',
            job_format: format,
            job_picked_pipeline: picked,
          },
        });
        return { jobId, mode, generated: 0, refused: true };
      }
    }

    const variantCount = job?.variantCount ?? 0;
    const intensity = (job?.intensity ?? 'medium') as 'small' | 'medium' | 'big';
    const conceptId = job?.conceptIds?.[0];
    if (variantCount <= 0 || !conceptId) {
      await step.run('mark-failed-validation', async () => {
        const db = getDb();
        await db
          .update(schema.generationJobs)
          .set({
            status: 'failed',
            errorMessage: 'variant_count or concept_id missing',
          })
          .where(eq(schema.generationJobs.id, jobId));
      });
      return { jobId, mode, generated: 0 };
    }

    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // ---------- mock path ----------

    if (mode === 'mock') {
      await step.sleep('mock-image-gen', '3s');
      await step.sleep('mock-copy-gen', '2s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount }, (_, i) => {
          const size = MOCK_SIZES[i % MOCK_SIZES.length]!;
          const aspectRatio = size === '1080x1080' ? '1:1' : size === '1080x1350' ? '4:5' : '9:16';
          const fakeUrl = `https://placehold.co/${size}/png?text=Variant+${i + 1}`;
          return {
            userId,
            generationJobId: jobId,
            fileUrl: fakeUrl,
            imageStoragePath: null,
            headline: `Mock headline ${i}`,
            primaryText: `Mock primary text for variant ${i} — this would be Claude-generated copy in live mode.`,
            description: `Mock description ${i}`,
            hookVariantIndex: i,
            bodyVariantIndex: i,
            ctaVariantIndex: i,
            aspectRatio: aspectRatio as '1:1' | '4:5' | '9:16',
            status: 'ready_for_review' as const,
            format: 'static_gemini_image',
            generationMetadata: { mock: true, variant_index: i },
          };
        });
        await db.insert(schema.generatedCreatives).values(rows);
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        path: 'static',
        variantCount,
        actualCostUsd: 0,
      });
      return { jobId, mode, generated: variantCount };
    }

    // ---------- live path ----------

    const claudeResult = await step.run('claude-copy-variants', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          return { ok: false as const, error: err.message, costUsd: 0 };
        }
        throw err;
      }
      const apiKey = keys.claude!;

      // Load concept's static copy + niche to send to Claude.
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
        // Polish-28.3.7 Commit 92: prepend PSYWAR corpus + enable
        // prompt caching. Same wrapping the variations worker uses so
        // Claude's ephemeral cache is shared across the two pipelines
        // when the same user fires jobs back-to-back.
        systemPrompt: wrapWithPsywarCorpus(STATIC_WINNER_IMPORT_SYSTEM_PROMPT),
        cacheSystemPrompt: true,
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

    // Image gen + storage upload + DB insert per variant, parallel in
    // batches of CONCURRENCY. Each variant has its own step.run for retry
    // isolation; per-variant failures don't fail the whole job.
    const imageOutcomes: Array<{ index: number; ok: boolean; costUsd: number; error?: string }> =
      [];

    const variants = claudeResult.variants;
    for (let batchStart = 0; batchStart < variants.length; batchStart += CONCURRENCY) {
      const batch = variants.slice(batchStart, batchStart + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((variant, idxInBatch) =>
          step.run(`gen-image-${batchStart + idxInBatch}`, async () =>
            renderOneStaticVariant({
              userId,
              jobId,
              conceptId,
              variantIndex: batchStart + idxInBatch,
              copy: variant,
            }),
          ),
        ),
      );
      imageOutcomes.push(...batchResults);
    }

    const totalCost = claudeResult.costUsd + imageOutcomes.reduce((s, r) => s + r.costUsd, 0);
    const successCount = imageOutcomes.filter((r) => r.ok).length;

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      path: 'static',
      variantCount: successCount,
      actualCostUsd: totalCost,
      partialFailures: imageOutcomes.filter((r) => !r.ok),
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

export interface ClaudeCopyVariant {
  variant_index: number;
  intensity_level: 'small' | 'medium' | 'big';
  rationale?: string;
  headline: string;
  primary_text: string;
  description?: string;
}

export function parseVariantsArray(
  json: unknown,
  expectedCount: number,
): { ok: true; variants: ClaudeCopyVariant[] } | { ok: false; error: string } {
  if (
    !json ||
    typeof json !== 'object' ||
    !Array.isArray((json as { variants?: unknown }).variants)
  ) {
    return { ok: false, error: 'Claude response did not contain a variants[] array' };
  }
  const variants = (json as { variants: ClaudeCopyVariant[] }).variants;
  if (variants.length === 0) {
    return { ok: false, error: 'Claude returned zero variants' };
  }
  // Phase 3b accepts any non-zero count up to the requested. Phase 3.5 can
  // add the "retry to fill the gap" loop the spec mentions.
  void expectedCount;
  // Validate shape of each variant.
  for (const v of variants) {
    if (!v || typeof v.headline !== 'string' || typeof v.primary_text !== 'string') {
      return { ok: false, error: 'Claude variant missing required fields' };
    }
  }
  return { ok: true, variants };
}

async function renderOneStaticVariant(input: {
  userId: string;
  jobId: string;
  conceptId: string;
  variantIndex: number;
  copy: ClaudeCopyVariant;
}): Promise<{ index: number; ok: boolean; costUsd: number; error?: string }> {
  // Decrypt Gemini key + load reference image once per variant. We don't
  // share state across step.run boundaries, so each call pays this cost.
  // Trade-off accepted for retry isolation.
  let apiKey: string;
  try {
    const keys = await loadDecryptedKeys(input.userId, ['gemini']);
    apiKey = keys.gemini!;
  } catch (err) {
    return {
      index: input.variantIndex,
      ok: false,
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const db = getDb();
  const concept = await db.query.concepts.findFirst({
    where: eq(schema.concepts.id, input.conceptId),
    columns: { fileUrl: true },
  });
  if (!concept?.fileUrl) {
    return {
      index: input.variantIndex,
      ok: false,
      costUsd: 0,
      error: 'Concept reference image missing',
    };
  }

  let referenceImage;
  try {
    referenceImage = await downloadAsBase64({
      bucket: 'concepts',
      path: concept.fileUrl,
      maxBytes: 10 * 1024 * 1024, // 10 MB matches the static upload cap
    });
  } catch (err) {
    return {
      index: input.variantIndex,
      ok: false,
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Phase 3d: split into a system instruction (style-preservation rules)
  // + user message (the actual copy + aspect ratio for this variant). The
  // system instruction frames the call as an EDIT operation so Gemini
  // anchors on the reference image instead of inventing a new scene.
  const aspectRatio = aspectRatioForIndex(input.variantIndex);
  const systemInstruction = renderGeminiImageSystemInstruction(aspectRatio);
  const prompt = renderNanoBananaPrompt(input.copy, input.variantIndex);

  const image = await callGeminiImage({
    userId: input.userId,
    apiKey,
    systemInstruction,
    prompt,
    referenceImageBase64: referenceImage.base64,
    referenceImageMimeType: referenceImage.mimeType,
    generationJobId: input.jobId,
  });

  if (!image.ok || !image.imageBase64) {
    // Failure → mark this variant failed, don't crash the job.
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
      aspectRatio: aspectRatioForIndex(input.variantIndex),
      status: 'rejected',
      // Polish-25.3 Commit 18b-hotfix-2: tag every Gemini static
      // row (success + failure) so the review page's variant-level
      // image predicate flips to <img> even when the source
      // concept was uploaded as UGC video.
      format: 'static_gemini_image',
      generationMetadata: {
        variant_index: input.variantIndex,
        // Polish-25.8 Commit 56: run the Gemini error through the
        // Commit 54 classifier so denied_access / quota / too_large
        // surface the same actionable next-step guidance the Files
        // upload path shows. Without this, a project missing the
        // Generative Language API enablement just stored "Your
        // project has been denied access" with no fix hint.
        error: describeGeminiUploadError(image.errorMessage ?? 'Gemini Image returned no data'),
        claude_rationale: input.copy.rationale ?? null,
      },
    });
    return {
      index: input.variantIndex,
      ok: false,
      costUsd: image.costUsd,
      error: describeGeminiUploadError(image.errorMessage ?? 'Gemini Image returned no data'),
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
    aspectRatio: aspectRatioForIndex(input.variantIndex),
    status: 'ready_for_review',
    format: 'static_gemini_image',
    generationMetadata: {
      variant_index: input.variantIndex,
      claude_rationale: input.copy.rationale ?? null,
      gemini_system_instruction: systemInstruction,
      gemini_prompt_used: prompt,
      intensity_level: input.copy.intensity_level,
    },
  });

  return { index: input.variantIndex, ok: true, costUsd: image.costUsd };
}

function aspectRatioForIndex(i: number): '1:1' | '4:5' | '9:16' {
  const order: Array<'1:1' | '4:5' | '9:16'> = ['1:1', '4:5', '9:16'];
  return order[i % order.length]!;
}

type StaticAspectRatio = '1:1' | '4:5' | '9:16';

const ASPECT_POSITION_GUIDANCE: Record<StaticAspectRatio, string> = {
  '1:1': 'Square format — position the PRIMARY OVERLAY text in the upper third of the canvas.',
  '4:5': 'Portrait format — position the PRIMARY OVERLAY text in the upper-middle area.',
  '9:16':
    'Vertical / Stories format — position the PRIMARY OVERLAY text in the upper third, leaving the bottom 40% for the visual subject.',
};

/**
 * Phase 3d Part A — system instruction sent to Gemini Image. Frames the
 * call as an EDIT operation so the model preserves the reference image's
 * mockup style instead of inventing a new scene, and enforces the 8%
 * canvas safe margin so text never gets cropped.
 */
export function renderGeminiImageSystemInstruction(aspectRatio: StaticAspectRatio): string {
  return `You are an image editor, not an image generator. You will be given a reference image and a new headline + body copy. Your task is ONLY to replace the text overlaid on the reference image with the new copy.

Preserve everything else exactly:
- Same visual composition and framing
- Same background and lighting
- Same mockup style (e.g. iPhone popup, screenshot, notification card)
- Same color palette
- Same typography style (font family, weight, casing)
- Same text positioning within the canvas

The new text MUST fit entirely within the visible canvas with at least 8% safe margin from all edges. If the new text is longer than the original, scale the font size DOWN to fit. NEVER crop or clip text. NEVER let text extend beyond the visible area.

Aspect ratio for this output: ${aspectRatio}
${ASPECT_POSITION_GUIDANCE[aspectRatio]}`;
}

/**
 * Phase 3d Part B — user-message prompt with the variant's actual copy +
 * the (style-only) JSON template guidance. The PRIMARY DIRECTIVE block
 * in the template + the system instruction above do the heavy lifting;
 * this message just supplies the specific text values for this variant.
 */
export function renderNanoBananaPrompt(copy: ClaudeCopyVariant, variantIndex: number): string {
  const aspect = aspectRatioForIndex(variantIndex);
  const secondary = copy.primary_text.slice(0, 120);
  return `Edit the reference image. Replace its overlay text with the EXACT text below — do not invent or paraphrase. All text MUST fit inside the canvas with 8% safe margin.

PRIMARY OVERLAY (headline): ${JSON.stringify(copy.headline)}
SECONDARY OVERLAY (body): ${JSON.stringify(secondary)}

Aspect ratio: ${aspect}
Variant intensity: ${copy.intensity_level} (${
    copy.intensity_level === 'small'
      ? 'minimal aesthetic change'
      : copy.intensity_level === 'medium'
        ? 'noticeable aesthetic shift, same persona/setting'
        : 'fresh persona or angle, same offer'
  })
${copy.rationale ? `Rationale for this variant: ${copy.rationale}` : ''}

The JSON template below is overlay guidance — the PRIMARY DIRECTIVE (preserve reference style, replace text only) and the system instruction take precedence over any conflicting field in the JSON.

${NANO_BANANA_CLONING_PROMPT_TEMPLATE}`;
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
    },
  });
}

async function markJobCompleted(input: {
  jobId: string;
  userId: string;
  mode: 'mock' | 'live';
  startedAt: number;
  path: 'static' | 'ugc';
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
      path: input.path,
      cost_usd: input.actualCostUsd,
      partial_failures: input.partialFailures ?? [],
    },
  });
}
