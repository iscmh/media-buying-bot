/**
 * Polish-28.3.0 Commit 85: BYOK Instant UGC — VARIATIONS mode.
 *
 * Sibling of generate-polish28-clone-ugc.ts. Where clone mode
 * produces ONE video that replicates the source ad's specific
 * actor, variations mode produces N videos each with a DIFFERENT
 * persona pitching the SAME offer. This is the Meta A/B-testing
 * pattern operators actually want most of the time — launch 5
 * distinct spokespeople, measure which demographic converts, scale
 * the winner.
 *
 * Pipeline per job (single Claude batch + N parallel HeyGen chains):
 *
 *   A. load-job                  fetch generation_jobs + concept
 *   B. mark-processing           update status + progress
 *   C. preflight-byok            3-BYOK check: Claude, Gemini, HeyGen
 *                                (NO Replicate — no source-frame extract)
 *   D. load-source-context       persona + vision-analysis JSON from concept
 *   E. generate-variations       Claude batch call → N {persona, script} pairs
 *   F. fetch-heygen-voices       one GET /v2/voices call, shared across variants
 *   G. render-variants           Promise.all fan-out over N entries:
 *                                  - Nano Banana character (text-only prompt)
 *                                  - Match voice for this variant's persona
 *                                  - Upload character to HeyGen
 *                                  - Submit av4/generate (script + voice_id)
 *                                  - Poll until completed
 *                                  - Download + upload final video
 *                                  - Persist creative row
 *   H. mark-completed            aggregate cost + mark job done
 *
 * BYOK requirement: 3 keys (Claude, Gemini, HeyGen). Drops Replicate
 * from the clone-mode 4-BYOK gate — variations don't extract from the
 * source ad's video (characters generated fresh from persona text).
 *
 * Output: N x 9:16 vertical videos. Locked per Polish-28 spec.
 *
 * Parallelism note: fan-out uses Promise.all(step.run(...)) so each
 * variant's HeyGen chain runs concurrently. Inngest v3 supports this
 * via step.run identity-keyed by the step name (variantIndex-suffixed
 * here). For very large N (say 50+) HeyGen rate limits or Inngest's
 * per-function-invocation timeout could bite; not a concern at
 * typical N=1-10. Future Polish-28.4 could fan out via separate event
 * dispatch to give per-variant retry isolation.
 */
import { Buffer } from 'node:buffer';
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  cloneCharacterReferenceImage,
  composeNanoBananaCharacterClonePrompt,
  estimateHeygenAvatarIvCostUsd,
  fetchHeygenVoices,
  isTerminalAvatarIvStatus,
  matchHeygenVoiceForPersona,
  submitHeygenAvatarIvGeneration,
  checkHeygenAvatarIvStatus,
  uploadHeygenImageAsset,
  type HeygenVoice,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { loadDecryptedKeys, MissingProviderKeyError } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import {
  assertNoUndefinedForPostgres,
  assertScalarDefinedForPostgres,
  guardedStepRun,
  rethrowWithUndefinedContext,
} from '../lib/assert-no-undefined-for-postgres';
import { safeInngestStepReturn } from '../lib/strip-undefined';
import {
  POLISH28_VARIATIONS_SYSTEM_PROMPT,
  composePolish28VariationsUserPrompt,
  parsePolish28VariationsResponse,
  type Polish28VariationEntry,
} from '../lib/polish28-variations-prompt';
import { POLISH28_PSYWAR_CORPUS } from '../lib/polish28-psywar-corpus';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';

console.log(
  `[jobs.generate-polish28-variations-ugc] cold start — POLISH_VERSION=${POLISH_VERSION}`,
);

const HEYGEN_POLL_MAX_ATTEMPTS = 90;
const HEYGEN_POLL_INTERVAL_SECONDS = 15;
/** Hard cap per single-job invocation. Higher N should batch via
 *  multiple jobs or split via event dispatch in a future commit. */
const MAX_VARIANTS_PER_JOB = 10;

function nowIso(): string {
  return new Date().toISOString();
}

async function patchMetadata(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const row = await db.query.generationJobs.findFirst({
    where: eq(schema.generationJobs.id, jobId),
    columns: { metadata: true },
  });
  const existing = (row?.metadata ?? {}) as Record<string, unknown>;
  const cleaned = assertNoUndefinedForPostgres(
    { ...existing, ...patch },
    'polish28-variations:patchMetadata',
  );
  await db
    .update(schema.generationJobs)
    .set({ metadata: cleaned })
    .where(eq(schema.generationJobs.id, jobId));
}

export const generatePolish28VariationsUgc = inngest.createFunction(
  {
    id: 'generate-polish28-variations-ugc',
    name: 'Polish-28: BYOK Instant UGC — variations (N distinct spokespeople)',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish28-variations-ugc.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data as {
      jobId: string;
      userId: string;
      mode: 'mock' | 'live';
    };
    const startedAt = Date.now();

    try {
      const jobUserId = assertScalarDefinedForPostgres(userId, 'userId', 'polish28-var:entry');

      // ---------- Step A: load job ----------
      const job = await guardedStepRun(step, 'load-job', async () => {
        const db = getDb();
        const row = await db.query.generationJobs.findFirst({
          where: eq(schema.generationJobs.id, jobId),
          columns: { variantCount: true, metadata: true, conceptIds: true },
        });
        return safeInngestStepReturn(row ?? null);
      });
      if (!job) {
        await markJobFailed(jobId, jobUserId, 'Polish-28-variations: job row not found', 0);
        return { jobId, mode, generated: 0 };
      }
      const conceptId = job.conceptIds?.[0];
      if (!conceptId) {
        const msg =
          'Polish-28 variations requires a concept with vision-analyzed persona metadata.';
        await markJobFailed(jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }
      const requestedVariantCount = Math.max(
        1,
        Math.min(MAX_VARIANTS_PER_JOB, job.variantCount ?? 1),
      );

      // ---------- Step B: mark processing ----------
      await guardedStepRun(step, 'mark-processing', async () => {
        const db = getDb();
        await db
          .update(schema.generationJobs)
          .set({ status: 'processing' })
          .where(eq(schema.generationJobs.id, jobId));
        await patchMetadata(jobId, {
          polish28_progress: { step: 'mark-processing', pct: 3, at: nowIso() },
          polish28_mode: 'variations',
          polish28_variant_count_requested: requestedVariantCount,
        });
        return safeInngestStepReturn({ ok: true });
      });

      // ---------- Step C: preflight BYOK (3 keys) ----------
      const keys = await guardedStepRun(step, 'preflight-byok', async () => {
        try {
          const loaded = await loadDecryptedKeys(jobUserId, ['claude', 'gemini', 'heygen']);
          if (!loaded.claude) throw new MissingProviderKeyError('claude');
          if (!loaded.gemini) throw new MissingProviderKeyError('gemini');
          if (!loaded.heygen) throw new MissingProviderKeyError('heygen');
          return safeInngestStepReturn({
            claude: loaded.claude,
            gemini: loaded.gemini,
            heygen: loaded.heygen,
          });
        } catch (err) {
          if (err instanceof MissingProviderKeyError) {
            throw new NonRetriableError(
              `Polish-28 variations requires 3 BYOK keys (Claude + Gemini + HeyGen). ` +
                `Missing: ${err.message}. Connect at /settings/connections.`,
            );
          }
          throw err;
        }
      });

      // ---------- Step D: load concept + vision-analysis JSON ----------
      const source = await guardedStepRun(step, 'load-source-context', async () => {
        const db = getDb();
        const concept = await db.query.concepts.findFirst({
          where: eq(schema.concepts.id, conceptId),
          columns: { metadata: true, ugcOriginalScript: true },
        });
        if (!concept) {
          throw new NonRetriableError(`Polish-28-variations: concept ${conceptId} not found.`);
        }
        const conceptMeta = (concept.metadata ?? null) as Record<string, unknown> | null;
        const analysis = (conceptMeta?.['analysis'] ?? null) as Record<string, unknown> | null;
        const visionAnalysisJson = analysis ? JSON.stringify(analysis, null, 2) : null;
        return safeInngestStepReturn({
          visionAnalysisJson,
          ugcOriginalScript: concept.ugcOriginalScript ?? '',
        });
      });

      // ---------- Step E: generate N persona+script pairs via Claude ----------
      const variations = await guardedStepRun(step, 'generate-variations', async () => {
        const rawInput =
          source.visionAnalysisJson ??
          (source.ugcOriginalScript && source.ugcOriginalScript.trim().length >= 20
            ? source.ugcOriginalScript
            : null);
        if (!rawInput) {
          throw new NonRetriableError(
            `Polish-28-variations has no usable input: concept ${conceptId} has neither ` +
              `metadata.analysis (Gemini vision output) nor ugcOriginalScript >=20 chars. ` +
              `Re-run analyze-concept on this concept before submitting.`,
          );
        }
        const userPrompt = composePolish28VariationsUserPrompt(rawInput, requestedVariantCount);
        const r = await callClaude({
          userId: jobUserId,
          apiKey: keys.claude!,
          // Polish-28.3.6 Commit 91: prepend the full Psywar-branded
          // PSYWAR corpus (sections 28 + 29, ~416KB / ~100K tokens)
          // to the system prompt VERBATIM per operator directive
          // (no summarization, no folding). cacheSystemPrompt:true
          // marks the whole system block as cacheable — first call
          // pays full input cost, subsequent calls within the ~5min
          // cache TTL pay ~10% for the cached portion. Corpus goes
          // BEFORE the instruction prompt so both get cached together.
          systemPrompt:
            `# PSYWAR REFERENCE CORPUS (verbatim, do not summarize)\n\n` +
            `The following is the operator's Psywar-branded direct-response marketing\n` +
            `archive. Absorb its principles fully before generating variations. The\n` +
            `variation instructions follow below the corpus.\n\n` +
            `----- BEGIN PSYWAR CORPUS -----\n\n` +
            POLISH28_PSYWAR_CORPUS +
            `\n\n----- END PSYWAR CORPUS -----\n\n` +
            `# VARIATION GENERATION INSTRUCTIONS\n\n` +
            POLISH28_VARIATIONS_SYSTEM_PROMPT,
          cacheSystemPrompt: true,
          userMessage: userPrompt,
          maxTokens: 8000,
          generationJobId: jobId,
        });
        if (!r.ok || !r.text || r.text.trim().length === 0) {
          throw new NonRetriableError(
            `Polish-28-variations Claude batch call failed: ${r.errorMessage ?? 'unknown'}`,
          );
        }
        const parsed = parsePolish28VariationsResponse(r.text);
        if (parsed.entries.length === 0) {
          throw new NonRetriableError(
            `Polish-28-variations Claude returned 0 valid entries. ` +
              `Errors: ${parsed.errors.slice(0, 5).join(' | ')}. ` +
              `Raw excerpt: ${JSON.stringify(r.text.slice(0, 500))}`,
          );
        }
        await patchMetadata(jobId, {
          polish28_progress: { step: 'generate-variations', pct: 15, at: nowIso() },
          polish28_variations_returned: parsed.entries.length,
          polish28_variations_parse_errors: parsed.errors,
        });
        return safeInngestStepReturn({ entries: parsed.entries });
      });

      // ---------- Step F: fetch HeyGen voice roster (shared) ----------
      const voices = await guardedStepRun(step, 'fetch-heygen-voices', async () => {
        const fetched = await fetchHeygenVoices({
          userId: jobUserId,
          apiKey: keys.heygen!,
          generationJobId: jobId,
        });
        if (!fetched.ok || fetched.voices.length === 0) {
          throw new NonRetriableError(
            `Polish-28-variations HeyGen voice-list fetch failed: ${fetched.errorMessage ?? 'no voices returned'}`,
          );
        }
        return safeInngestStepReturn({ voices: fetched.voices });
      });

      // ---------- Step G: render each variant in parallel ----------
      const variantResults = await Promise.all(
        variations.entries.map((entry, index) =>
          renderOneVariant({
            step,
            index,
            entry,
            jobId,
            jobUserId,
            voices: voices.voices,
            keys: { gemini: keys.gemini!, heygen: keys.heygen! },
          }).catch((err) => {
            // Per-variant failures don't kill the whole job — log +
            // return a failure marker so the job still persists the
            // successful variants.
            console.error(`[polish28-var] variant ${index} failed:`, err);
            return {
              ok: false as const,
              index,
              error: err instanceof Error ? err.message : String(err),
            };
          }),
        ),
      );

      const succeeded = variantResults.filter(
        (r): r is { ok: true; index: number; costUsd: number } => r.ok,
      );
      const failed = variantResults.filter(
        (r): r is { ok: false; index: number; error: string } => !r.ok,
      );

      // ---------- Step H: mark completed ----------
      const totalCost = succeeded.reduce((sum, r) => sum + r.costUsd, 0);
      if (succeeded.length === 0) {
        const firstErr = failed[0]?.error ?? 'all variants failed with no error';
        await markJobFailed(
          jobId,
          jobUserId,
          `Polish-28-variations: all ${variantResults.length} variants failed. First: ${firstErr}`,
          totalCost,
        );
        throw new NonRetriableError(
          `Polish-28-variations: 0/${variantResults.length} variants succeeded. First error: ${firstErr}`,
        );
      }
      await markJobCompleted({
        jobId,
        userId: jobUserId,
        mode,
        startedAt,
        variantCount: succeeded.length,
        actualCostUsd: totalCost,
        provider: 'clone_ugc',
        path: 'ugc',
      });
      await patchMetadata(jobId, {
        polish28_progress: { step: 'completed', pct: 100, at: nowIso() },
        polish28_variants_succeeded: succeeded.length,
        polish28_variants_failed: failed.length,
        polish28_variants_failures: failed.map((f) => ({
          index: f.index,
          error: f.error.slice(0, 500),
        })),
      });
      return {
        jobId,
        mode,
        generated: succeeded.length,
        failed: failed.length,
        totalCostUsd: totalCost,
      };
    } catch (err) {
      rethrowWithUndefinedContext(err, 'generatePolish28VariationsUgc');
    }
  },
);

// Inngest's step type is inferred from the handler tools object.
// Loosely typed here to sidestep Inngest's Jsonify-wrapped return
// types — the actual step calls inside renderOneVariant type-check
// fine at the callsite thanks to inference from the arg fn.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InngestStepTools = any;

interface RenderOneInput {
  step: InngestStepTools;
  index: number;
  entry: Polish28VariationEntry;
  jobId: string;
  jobUserId: string;
  voices: readonly HeygenVoice[];
  keys: { gemini: string; heygen: string };
}

type RenderOneResult =
  | { ok: true; index: number; costUsd: number }
  | { ok: false; index: number; error: string };

/**
 * Render one variation end-to-end: Nano Banana character → match voice
 * → upload to HeyGen → submit av4 → poll → download → persist. Each
 * step uses a variantIndex-suffixed name so Inngest can uniquely
 * memoize per-variant steps within one function invocation.
 */
async function renderOneVariant(input: RenderOneInput): Promise<RenderOneResult> {
  const { step, index, entry, jobId, jobUserId, voices, keys } = input;
  const stepSuffix = `v${index}`;

  // 1. Nano Banana character (text-only, no source frame reference)
  const characterUpload = await step.run(`clone-character-${stepSuffix}`, async () => {
    // Compose a persona-text description string that the existing
    // clonecharacter prompt can consume. We build a flattened persona
    // string in the same shape flattenPersonaForClonePrompt would emit.
    const personaText =
      `Age: ${entry.persona.age_range}. Gender: ${entry.persona.gender}. ` +
      `Ethnicity: ${entry.persona.ethnicity}. Look: ${entry.persona.look}`;
    const prompt = composeNanoBananaCharacterClonePrompt(personaText);
    // No reference image — variations mode intentionally generates a
    // fresh character from persona text alone. cloneCharacterReferenceImage
    // requires a ref image; we work around by sending a 1x1 gray PNG as
    // a placeholder ref. Nano Banana Pro treats a tiny ref as a weak
    // signal and generates primarily from the prompt.
    const grayPixelPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const r = await cloneCharacterReferenceImage({
      userId: jobUserId,
      apiKey: keys.gemini,
      prompt,
      referenceImageBase64: grayPixelPngBase64,
      referenceImageMimeType: 'image/png',
      generationJobId: jobId,
    });
    if (!r.ok || !r.imageBase64) {
      throw new Error(
        `variant ${index} Nano Banana character failed: ${r.errorMessage ?? 'unknown'}`,
      );
    }
    const uploaded = await uploadGeneratedImage({
      userId: jobUserId,
      jobId,
      variantIndex: index,
      imageBase64: r.imageBase64,
      mimeType: r.imageMimeType ?? 'image/png',
      filenamePrefix: `polish28-var${index}-character-`,
    });
    return {
      publicUrl: uploaded.publicUrl,
      storagePath: uploaded.path,
      mimeType: r.imageMimeType ?? 'image/png',
      costUsd: r.costUsd,
    };
  });

  // 2. Match voice for this variant's persona
  const personaSentenceForMatch =
    `${entry.persona.age_range} ${entry.persona.gender} ${entry.persona.ethnicity}. ` +
    entry.persona.look;
  const matchedVoice = matchHeygenVoiceForPersona(voices, personaSentenceForMatch);

  // 3. Upload character to HeyGen
  const heygenImageKey = await step.run(`upload-heygen-image-${stepSuffix}`, async () => {
    const fetchRes = await fetch(characterUpload.publicUrl);
    if (!fetchRes.ok) {
      throw new Error(`variant ${index} character-fetch HTTP ${fetchRes.status}`);
    }
    const arr = await fetchRes.arrayBuffer();
    const bytes = new Uint8Array(arr);
    const characterMime =
      characterUpload.mimeType === 'image/jpeg' || characterUpload.mimeType === 'image/jpg'
        ? 'image/jpeg'
        : 'image/png';
    const r = await uploadHeygenImageAsset({
      userId: jobUserId,
      apiKey: keys.heygen,
      imageBytes: bytes,
      imageMimeType: characterMime,
      generationJobId: jobId,
    });
    if (!r.ok || !r.imageKey) {
      throw new Error(`variant ${index} HeyGen upload failed: ${r.errorMessage ?? 'unknown'}`);
    }
    return r.imageKey;
  });

  // 4. Submit av4/generate with script + voice_id
  const heygenVideoId = await step.run(`submit-heygen-${stepSuffix}`, async () => {
    const r = await submitHeygenAvatarIvGeneration({
      userId: jobUserId,
      apiKey: keys.heygen,
      imageKey: heygenImageKey,
      script: entry.script,
      voiceId: matchedVoice.voice_id,
      videoTitle: `polish28_var_${jobId.slice(0, 8)}_${index}`,
      generationJobId: jobId,
    });
    if (!r.ok || !r.videoId) {
      throw new Error(`variant ${index} HeyGen submit failed: ${r.errorMessage ?? 'unknown'}`);
    }
    return r.videoId;
  });

  // 5. Poll for completion (chunked)
  let finalVideoUrl: string | null = null;
  let finalDurationSeconds: number | null = null;
  for (let attempt = 0; attempt < HEYGEN_POLL_MAX_ATTEMPTS; attempt++) {
    const pollResult = await step.run(`poll-heygen-${stepSuffix}-${attempt}`, async () => {
      const r = await checkHeygenAvatarIvStatus({
        userId: jobUserId,
        apiKey: keys.heygen,
        videoId: heygenVideoId,
        generationJobId: jobId,
      });
      return {
        ok: r.ok,
        status: r.status,
        videoUrl: r.videoUrl ?? null,
        durationSeconds: r.durationSeconds ?? null,
        errorMessage: r.errorMessage ?? null,
      };
    });
    if (!pollResult.ok || pollResult.status === 'failed') {
      throw new Error(
        `variant ${index} HeyGen failed after ${attempt + 1} polls: ${pollResult.errorMessage ?? 'unknown'}`,
      );
    }
    if (pollResult.status === 'completed' && pollResult.videoUrl) {
      finalVideoUrl = pollResult.videoUrl;
      finalDurationSeconds = pollResult.durationSeconds;
      break;
    }
    if (isTerminalAvatarIvStatus(pollResult.status)) break;
    await step.sleep(`poll-wait-${stepSuffix}-${attempt}`, `${HEYGEN_POLL_INTERVAL_SECONDS}s`);
  }
  if (!finalVideoUrl) {
    throw new Error(`variant ${index} HeyGen timed out after ${HEYGEN_POLL_MAX_ATTEMPTS} polls`);
  }

  // 6. Download + upload to Supabase
  const uploaded = await step.run(`upload-final-${stepSuffix}`, async () => {
    const r = await uploadGeneratedVideoFromUrl({
      userId: jobUserId,
      jobId,
      remoteUrl: finalVideoUrl!,
      filename: `polish28-var${index}-lipsync`,
      compress: true,
    });
    return { path: r.path, publicUrl: r.publicUrl, sizeBytes: r.sizeBytes };
  });

  // 7. Persist creative row
  await step.run(`persist-creative-${stepSuffix}`, async () => {
    const db = getDb();
    // DO NOT set imageStoragePath — that would misclassify as image
    // (see Commit 82 / job-review-client isImageVariant predicate).
    const creativeRecord = assertNoUndefinedForPostgres(
      {
        userId: jobUserId,
        generationJobId: jobId,
        fileUrl: uploaded.publicUrl,
        hookVariantIndex: index,
        bodyVariantIndex: index,
        ctaVariantIndex: index,
        aspectRatio: '9:16' as const,
      },
      'polish28-variations:generated-creatives-insert',
    );
    await db
      .insert(schema.generatedCreatives)
      .values(creativeRecord as typeof schema.generatedCreatives.$inferInsert);
    return { inserted: true };
  });

  const heygenCost = estimateHeygenAvatarIvCostUsd(finalDurationSeconds ?? 30);
  const variantCost = heygenCost + (characterUpload.costUsd ?? 0) + 0.02;
  await patchMetadata(jobId, {
    [`polish28_var_${index}_status`]: 'completed',
    [`polish28_var_${index}_persona`]: entry.persona,
    [`polish28_var_${index}_voice`]: {
      voice_id: matchedVoice.voice_id,
      name: matchedVoice.name,
      gender: matchedVoice.gender,
    },
    [`polish28_var_${index}_video_url`]: uploaded.publicUrl,
    [`polish28_var_${index}_cost_usd`]: variantCost,
  });

  // Suppress unused-var lint on Buffer import — kept for future use
  // if we need to base64-decode audio bytes.
  void Buffer;
  return { ok: true, index, costUsd: variantCost };
}
