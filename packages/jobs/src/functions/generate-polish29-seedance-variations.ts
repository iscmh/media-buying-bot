/**
 * Polish-29.0.10 Commit 119: credit-backed multi-clip Seedance
 * VARIATIONS worker — the "feed winning creative, get N cloned-
 * character variations" flow.
 *
 * Value prop:
 *   1. User uploaded a winning ad (any length; typical 30-60s).
 *   2. Vision analysis extracted persona + script structure.
 *   3. Claude generates N distinct persona+script pairs.
 *   4. For each variation:
 *        - Nano Banana Pro renders ONE character-reference PNG from
 *          persona.look — visual anchor threaded through every clip.
 *        - The script splits into M ~8-second clip-length chunks
 *          matching the source ad's duration (~22 words per clip
 *          at 170 wpm).
 *        - For each of the M clips: Seedance i2v with:
 *            image ref  = the Nano Banana PNG
 *            prompt     = persona-lock prefix + segment dialogue
 *          Each clip is one credit-reserved call at the chosen tier
 *          (2.0 Fast / 2.0 / 2.5). Character consistency = image
 *          reference; script continuity = same persona prefix.
 *        - Replicate ffmpeg-concat stitches the M clips into one
 *          composite matching source ad length.
 *        - Store composite → persist creative row.
 *   5. Output: N full-length composite ads, each a different
 *      persona pitching the same offer.
 *
 * BYOK requirement: Claude (batch persona+script), Gemini (Nano
 * Banana Pro character reference), Replicate (ffmpeg concat).
 * The Seedance video render itself pays in CREDITS via useapi.net.
 * Zero HeyGen / ElevenLabs — Seedance's own audio generation covers
 * lip-sync + voice.
 *
 * Per-clip credit ledger (via runSeedanceCreditedJob from Commit
 * 114): reserve → submit → poll → consume on success, release on
 * failure. Partial success = user pays only for the clips that
 * rendered.
 *
 * Cost example (5 variations, source ad = 32s → 4 clips per variant):
 *   5 × 4 × 20 credits (Seedance 2.0) = 400 credits = $8.00
 *   plus Claude batch (~$0.05) + 5 × Nano Banana ($0.13 each) +
 *   5 × Replicate concat (~$0.02 each). Retail equivalent for the
 *   video generation alone: 5 × 4 × $2.25 = $45.
 */
import { Buffer } from 'node:buffer';
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  checkReplicateConcat,
  cloneCharacterReferenceImage,
  composeNanoBananaCharacterClonePrompt,
  submitReplicateConcat,
} from '@mbb/ai-providers';
import { getDb, InsufficientCreditsError, schema } from '@mbb/db';
import { getCreditModel, POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { loadDecryptedKeys, MissingProviderKeyError } from '../lib/load-keys';
import { markJobFailed } from '../lib/job-markers';
import {
  assertNoUndefinedForPostgres,
  assertScalarDefinedForPostgres,
  guardedStepRun,
} from '../lib/assert-no-undefined-for-postgres';
import { safeInngestStepReturn } from '../lib/strip-undefined';
import {
  POLISH28_VARIATIONS_SYSTEM_PROMPT,
  composePolish28VariationsUserPrompt,
  parsePolish28VariationsResponse,
  type Polish28VariationEntry,
} from '../lib/polish28-variations-prompt';
// Polish-29.0.15 Commit 124: intentionally NOT importing
// wrapWithPsywarCorpus. Its "psychological manipulation techniques"
// framing triggers Claude Sonnet 4.5+ refusals (observed on 29.0.14 —
// Claude returned a prose safety flag instead of JSON, which broke the
// parser). The Polish-28 variations prompt on its own reads as normal
// ad-copy work and produces the persona+script JSON cleanly.
import { runSeedanceCreditedJob } from '../lib/seedance-credit-flow';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';

console.log(
  `[jobs.generate-polish29-seedance-variations] cold start — POLISH_VERSION=${POLISH_VERSION}`,
);

// -----------------------------------------------------------------
// Constants
// -----------------------------------------------------------------

const MAX_VARIANTS_PER_JOB = 10;
/** Max clips per variation. 10 × 8s = 80s composite cap. */
const MAX_CLIPS_PER_VARIANT = 10;
/** Min clips per variation. */
const MIN_CLIPS_PER_VARIANT = 2;
/** Default clips when source ad duration is unknown. */
const DEFAULT_CLIPS_PER_VARIANT = 4;
/** Seedance clip length in seconds. 8s = Seedance's per-call max. */
const SEEDANCE_CLIP_SECONDS = 8;
/** Words per clip: 170 wpm × 8s ≈ 22 words. Keeps dialogue segmentation
 *  aligned with Seedance's audio timing. */
const WORDS_PER_CLIP = 22;
const DEFAULT_MODEL_ID = 'seedance-2-0-ugc';
const ALLOWED_MODEL_IDS = new Set([
  'seedance-2-5-ugc',
  'seedance-2-0-ugc',
  'seedance-2-0-fast-ugc',
]);

const CONCAT_POLL_INTERVAL_SECONDS = 5;
const CONCAT_POLL_MAX_ATTEMPTS = 36; // ~3 min

/**
 * Event payload shape.
 *
 * The concept-generate form dispatches through analyze-concept, which
 * only forwards {jobId, userId, mode}. So pipeline-specific config
 * (modelId / aspectRatio / dreaminaAccount) is read from:
 *   - job.metadata.model_id (set by the form's actions.ts when the
 *     Polish-29 variations card is picked)
 *   - job.metadata.aspect_ratio (form-controlled; defaults to 9:16)
 *   - USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT env var (platform-side
 *     Dreamina account registered on useapi.net; same source the
 *     Quick Seedance form uses)
 *
 * Direct-dispatch API callers (integration tests, Inngest replay from
 * the dashboard) can override any of these via event.data.
 */
export interface Polish29SeedanceVariationsEventPayload {
  jobId: string;
  userId: string;
  dreaminaAccount?: string;
  modelId?: string;
  aspectRatio?: '9:16' | '1:1';
}

// -----------------------------------------------------------------
// Helpers (pure — trivial to test in isolation later)
// -----------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Given a full script string, chunk into N ~equal segments where each
 * segment is ≤ WORDS_PER_CLIP words. Returns [] on empty input.
 */
export function splitScriptIntoClips(script: string, targetClipCount: number): string[] {
  const words = script.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const clamped = Math.max(MIN_CLIPS_PER_VARIANT, Math.min(MAX_CLIPS_PER_VARIANT, targetClipCount));
  // Prefer script length as the actual driver: if 22-word clips fit
  // fewer than `clamped` chunks, honor the shorter count so the last
  // clip isn't padded with silence.
  const naturalCount = Math.max(1, Math.ceil(words.length / WORDS_PER_CLIP));
  const finalCount = Math.max(MIN_CLIPS_PER_VARIANT, Math.min(clamped, naturalCount));
  const wordsPerChunk = Math.ceil(words.length / finalCount);
  const out: string[] = [];
  for (let i = 0; i < finalCount; i++) {
    const start = i * wordsPerChunk;
    const end = Math.min(words.length, start + wordsPerChunk);
    if (start >= words.length) break;
    out.push(words.slice(start, end).join(' '));
  }
  return out;
}

/**
 * Derive clip count from source ad duration. If unknown, default to
 * DEFAULT_CLIPS_PER_VARIANT (~32s composite). Clamped to
 * [MIN_CLIPS_PER_VARIANT, MAX_CLIPS_PER_VARIANT].
 */
export function pickClipCountForSourceDuration(sourceSeconds: number | null): number {
  if (!sourceSeconds || sourceSeconds <= 0 || !Number.isFinite(sourceSeconds)) {
    return DEFAULT_CLIPS_PER_VARIANT;
  }
  const raw = Math.round(sourceSeconds / SEEDANCE_CLIP_SECONDS);
  return Math.max(MIN_CLIPS_PER_VARIANT, Math.min(MAX_CLIPS_PER_VARIANT, raw));
}

/**
 * Compose the per-clip Seedance prompt. The character-lock prefix
 * repeats verbatim across every clip in a variation so Seedance sees
 * identical persona text on every call. The image reference PNG
 * (Nano Banana output) is the visual anchor; this prefix is the text
 * anchor. Together they minimize character drift between clips.
 */
export function composeClipPrompt(input: {
  personaLockPrefix: string;
  clipDialogue: string;
  clipIndex: number;
  totalClips: number;
}): string {
  const { personaLockPrefix, clipDialogue, clipIndex, totalClips } = input;
  return [
    `${personaLockPrefix}\n\n`,
    `This is clip ${clipIndex + 1} of ${totalClips} in one UGC ad. `,
    `Same person, same setting, same clothing, same lighting as the reference image. `,
    `Filmed on a phone camera, natural lighting, direct-to-camera delivery. `,
    `The speaker says (deliver naturally, not word-perfect): "${clipDialogue.replace(/\s+/g, ' ').trim()}"`,
  ].join('');
}

/**
 * Compose the persona-lock prefix from Claude's persona output. This
 * prefix is threaded verbatim into every clip's Seedance prompt for
 * the variation — the same "same person" hint Google Veo used in the
 * Polish-23 CHARACTER LOCK pattern.
 */
export function composePersonaLockPrefix(persona: Polish28VariationEntry['persona']): string {
  return [
    `SAME PERSON THROUGHOUT — do not change identity between clips:`,
    `- A ${persona.age_range} ${persona.ethnicity} ${persona.gender}.`,
    `- Look: ${persona.look}`,
  ].join('\n');
}

// -----------------------------------------------------------------
// Metadata patch helper
// -----------------------------------------------------------------

async function patchMetadata(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const row = await db.query.generationJobs.findFirst({
    where: eq(schema.generationJobs.id, jobId),
    columns: { metadata: true },
  });
  const existing = (row?.metadata ?? {}) as Record<string, unknown>;
  const cleaned = assertNoUndefinedForPostgres(
    { ...existing, ...patch },
    'polish29-seedance-variations:patchMetadata',
  );
  await db
    .update(schema.generationJobs)
    .set({ metadata: cleaned })
    .where(eq(schema.generationJobs.id, jobId));
}

// -----------------------------------------------------------------
// Inngest worker
// -----------------------------------------------------------------

export const generatePolish29SeedanceVariations = inngest.createFunction(
  {
    id: 'generate-polish29-seedance-variations',
    name: 'Polish-29: credit-backed multi-clip Seedance variations',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish29-seedance-variations.requested' },
  async ({ event, step }) => {
    const data = event.data as Polish29SeedanceVariationsEventPayload;
    const startedAt = Date.now();
    const jobUserId = assertScalarDefinedForPostgres(
      data.userId,
      'userId',
      'polish29-seedance-var:entry',
    );

    // ---------- A: load job ----------
    const job = await guardedStepRun(step, 'load-job', async () => {
      const db = getDb();
      const row = await db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, data.jobId),
        columns: { variantCount: true, metadata: true, conceptIds: true },
      });
      return safeInngestStepReturn(row ?? null);
    });
    if (!job) {
      await markJobFailed(data.jobId, jobUserId, 'Job row not found', 0);
      return { jobId: data.jobId, generated: 0 };
    }
    const conceptId = job.conceptIds?.[0];
    if (!conceptId) {
      const msg =
        'Seedance-variations requires a concept with vision-analyzed metadata. ' +
        'Upload the source ad and re-run analyze-concept first.';
      await markJobFailed(data.jobId, jobUserId, msg, 0);
      throw new NonRetriableError(msg);
    }
    const requestedVariantCount = Math.max(
      1,
      Math.min(MAX_VARIANTS_PER_JOB, job.variantCount ?? 1),
    );

    // Resolve pipeline-specific config: event.data wins (direct API /
    // Inngest replay), else read from job.metadata (concept-form path),
    // else env / defaults.
    const jobMetadata = (job.metadata ?? {}) as Record<string, unknown>;
    // Prefer the pipeline-specific slot so this worker never fights
    // analyze-concept's metadata.model_id → video-variant dispatch.
    // Fall back to model_id if present (direct-dispatch / test paths
    // sometimes set it there).
    const metaModelId =
      typeof jobMetadata['polish29_model_id'] === 'string'
        ? (jobMetadata['polish29_model_id'] as string)
        : typeof jobMetadata['model_id'] === 'string'
          ? (jobMetadata['model_id'] as string)
          : undefined;
    const metaAspectRatio =
      typeof jobMetadata['aspect_ratio'] === 'string'
        ? (jobMetadata['aspect_ratio'] as string)
        : undefined;
    const modelIdCandidate = data.modelId ?? metaModelId ?? DEFAULT_MODEL_ID;
    const modelId = ALLOWED_MODEL_IDS.has(modelIdCandidate) ? modelIdCandidate : DEFAULT_MODEL_ID;
    const model = getCreditModel(modelId);
    const aspectRatioCandidate = data.aspectRatio ?? metaAspectRatio ?? '9:16';
    const aspectRatio: '9:16' | '1:1' = aspectRatioCandidate === '1:1' ? '1:1' : '9:16';
    // Dreamina account: platform-side registered account on useapi.net,
    // NOT a per-user field. Same env var the Quick Seedance form reads.
    const dreaminaAccount =
      data.dreaminaAccount ?? process.env['USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT'];
    if (!dreaminaAccount) {
      const msg =
        'USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT env var is unset. An admin needs to register a ' +
        'Dreamina account on useapi.net and set the env var to that account email.';
      await markJobFailed(data.jobId, jobUserId, msg, 0);
      throw new NonRetriableError(msg);
    }

    // ---------- B: mark processing ----------
    await guardedStepRun(step, 'mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, data.jobId));
      await patchMetadata(data.jobId, {
        polish29_seedance_variations_start: {
          model_id: modelId,
          variant_count_requested: requestedVariantCount,
          per_clip_credits: model.credits,
          aspect_ratio: aspectRatio,
          at: nowIso(),
        },
      });
      return safeInngestStepReturn({ ok: true });
    });

    // ---------- C: preflight BYOK (Claude + Gemini + Replicate) ----------
    // NOTE: Replicate lives under the 'kling' slot on DecryptedKeys —
    // that's the legacy tag Polish-20 kept when the Replicate shared
    // helpers (concat / lipsync / audio / frame) all coalesced on one
    // Replicate token. Same pattern as generate-video-variant +
    // generate-polish23-veo-lite.
    const keys = await guardedStepRun(step, 'preflight-byok', async () => {
      try {
        const loaded = await loadDecryptedKeys(jobUserId, ['claude', 'gemini', 'kling']);
        if (!loaded.claude) throw new MissingProviderKeyError('claude');
        if (!loaded.gemini) throw new MissingProviderKeyError('gemini');
        if (!loaded.kling) throw new MissingProviderKeyError('kling');
        return safeInngestStepReturn({
          claude: loaded.claude,
          gemini: loaded.gemini,
          kling: loaded.kling,
        });
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          throw new NonRetriableError(
            `Seedance variations needs 3 BYOK keys (Claude + Gemini + Replicate). ` +
              `Missing: ${err.message}. Connect at /settings/connections. ` +
              `(Video render itself pays in credits — these keys drive persona+script batch, character reference, and clip concat.)`,
          );
        }
        throw err;
      }
    });

    // ---------- D: load concept + vision-analysis JSON + source duration ----------
    const source = await guardedStepRun(step, 'load-source-context', async () => {
      const db = getDb();
      const concept = await db.query.concepts.findFirst({
        where: eq(schema.concepts.id, conceptId),
        columns: { metadata: true, ugcOriginalScript: true },
      });
      if (!concept) {
        throw new NonRetriableError(`Seedance-variations: concept ${conceptId} not found.`);
      }
      const conceptMeta = (concept.metadata ?? null) as Record<string, unknown> | null;
      const analysis = (conceptMeta?.['analysis'] ?? null) as Record<string, unknown> | null;
      const visionAnalysisJson = analysis ? JSON.stringify(analysis, null, 2) : null;
      const sourceSecondsRaw = analysis?.['duration_seconds'];
      const sourceSeconds =
        typeof sourceSecondsRaw === 'number' && Number.isFinite(sourceSecondsRaw)
          ? sourceSecondsRaw
          : null;
      return safeInngestStepReturn({
        visionAnalysisJson,
        ugcOriginalScript: concept.ugcOriginalScript ?? '',
        sourceSeconds,
      });
    });

    const clipsPerVariant = pickClipCountForSourceDuration(source.sourceSeconds);

    // ---------- E: Claude batch → N persona+script pairs ----------
    const variations = await guardedStepRun(step, 'generate-variations', async () => {
      const rawInput =
        source.visionAnalysisJson ??
        (source.ugcOriginalScript && source.ugcOriginalScript.trim().length >= 20
          ? source.ugcOriginalScript
          : null);
      if (!rawInput) {
        throw new NonRetriableError(
          `Concept ${conceptId} has no vision-analyzed metadata or usable original script. ` +
            `Re-run analyze-concept on this concept before submitting.`,
        );
      }
      const userPrompt = composePolish28VariationsUserPrompt(rawInput, requestedVariantCount);
      const r = await callClaude({
        userId: jobUserId,
        apiKey: keys.claude,
        systemPrompt: POLISH28_VARIATIONS_SYSTEM_PROMPT,
        cacheSystemPrompt: true,
        userMessage: userPrompt,
        maxTokens: 8000,
        generationJobId: data.jobId,
      });
      if (!r.ok || !r.text || r.text.trim().length === 0) {
        throw new NonRetriableError(
          `Claude batch call failed: ${r.errorMessage ?? 'empty response'}`,
        );
      }
      const parsed = parsePolish28VariationsResponse(r.text);
      if (parsed.entries.length === 0) {
        throw new NonRetriableError(
          `Claude returned 0 valid persona+script entries. Errors: ${parsed.errors.slice(0, 5).join(' | ')}`,
        );
      }
      await patchMetadata(data.jobId, {
        polish29_seedance_variations_batch: {
          variations_returned: parsed.entries.length,
          parse_errors: parsed.errors,
          clips_per_variant: clipsPerVariant,
          source_seconds: source.sourceSeconds,
          at: nowIso(),
        },
      });
      return safeInngestStepReturn({ entries: parsed.entries });
    });

    // ---------- F: render each variation in parallel ----------
    const variantResults = await Promise.all(
      variations.entries.map((entry, index) =>
        renderOneVariation({
          step,
          index,
          entry,
          jobId: data.jobId,
          userId: jobUserId,
          dreaminaAccount,
          modelId,
          aspectRatio,
          clipsPerVariant,
          keys,
        }).catch((err) => {
          console.error(`[polish29-seedance-var] variation ${index} failed:`, err);
          return {
            index,
            ok: false as const,
            errorMessage: err instanceof Error ? err.message : String(err),
            creditsSpent: 0,
            clipsSucceeded: 0,
            clipsTotal: clipsPerVariant,
          };
        }),
      ),
    );

    const successful = variantResults.filter((r) => r.ok);
    const failed = variantResults.filter((r) => !r.ok);
    const totalCreditsSpent = variantResults.reduce((sum, r) => sum + (r.creditsSpent ?? 0), 0);

    // ---------- G: mark completed ----------
    await guardedStepRun(step, 'mark-completed', async () => {
      const db = getDb();
      const durationMs = Date.now() - startedAt;
      const anySucceeded = successful.length > 0;
      await db
        .update(schema.generationJobs)
        .set({
          status: anySucceeded ? 'completed' : 'failed',
          completedAt: new Date(),
          generatedCreativeCount: successful.length,
          errorMessage: anySucceeded
            ? null
            : `All ${variantResults.length} variations failed. First error: ${failed[0]?.errorMessage ?? 'unknown'}`,
        })
        .where(eq(schema.generationJobs.id, data.jobId));
      await patchMetadata(data.jobId, {
        polish29_seedance_variations_summary: {
          requested: variations.entries.length,
          succeeded: successful.length,
          failed: failed.length,
          clips_per_variant: clipsPerVariant,
          per_clip_credits: model.credits,
          total_credits_spent: totalCreditsSpent,
          model_id: modelId,
          duration_ms: durationMs,
          at: nowIso(),
          failures: failed.map((r) => ({
            index: r.index,
            errorMessage: r.errorMessage,
            clips_succeeded: r.clipsSucceeded,
            clips_total: r.clipsTotal,
          })),
        },
      });
      return safeInngestStepReturn({ ok: true });
    });

    return {
      jobId: data.jobId,
      generated: successful.length,
      failed: failed.length,
      totalCreditsSpent,
    };
  },
);

// -----------------------------------------------------------------
// Per-variation renderer — the actual multi-clip chain + concat
// -----------------------------------------------------------------

interface RenderOneVariationInput {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  index: number;
  entry: Polish28VariationEntry;
  jobId: string;
  userId: string;
  dreaminaAccount: string;
  modelId: string;
  aspectRatio: '9:16' | '1:1';
  clipsPerVariant: number;
  keys: { claude: string; gemini: string; kling: string };
}

type RenderOneVariationResult =
  | {
      index: number;
      ok: true;
      compositeUrl: string;
      creditsSpent: number;
      clipsSucceeded: number;
      clipsTotal: number;
    }
  | {
      index: number;
      ok: false;
      errorMessage: string;
      creditsSpent: number;
      clipsSucceeded: number;
      clipsTotal: number;
    };

async function renderOneVariation(
  input: RenderOneVariationInput,
): Promise<RenderOneVariationResult> {
  const { step, index, entry, jobId, userId, dreaminaAccount, modelId, aspectRatio, keys } = input;
  const stepSuffix = `v${index}`;

  // 1. Nano Banana Pro character reference PNG. Grey-pixel placeholder
  //    as the required-but-weak ref image (same trick Polish-28
  //    variations uses); the prompt does the character work.
  const character = await guardedStepRun(step, `char-ref-${stepSuffix}`, async () => {
    const personaText =
      `Age: ${entry.persona.age_range}. Gender: ${entry.persona.gender}. ` +
      `Ethnicity: ${entry.persona.ethnicity}. Look: ${entry.persona.look}`;
    const prompt = composeNanoBananaCharacterClonePrompt(personaText);
    const grayPixelPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const r = await cloneCharacterReferenceImage({
      userId,
      apiKey: keys.gemini,
      prompt,
      referenceImageBase64: grayPixelPngBase64,
      referenceImageMimeType: 'image/png',
      generationJobId: jobId,
    });
    if (!r.ok || !r.imageBase64) {
      throw new Error(`Nano Banana character failed: ${r.errorMessage ?? 'unknown'}`);
    }
    const uploaded = await uploadGeneratedImage({
      userId,
      jobId,
      variantIndex: index,
      imageBase64: r.imageBase64,
      mimeType: r.imageMimeType ?? 'image/png',
      filenamePrefix: `polish29-var${index}-character-`,
    });
    return safeInngestStepReturn({
      publicUrl: uploaded.publicUrl,
      mimeType: r.imageMimeType ?? 'image/png',
    });
  });

  // 2. Split the script into M clip-length segments.
  const clipDialogues = splitScriptIntoClips(entry.script, input.clipsPerVariant);
  if (clipDialogues.length === 0) {
    throw new Error(`variation ${index}: script split produced 0 clips (script too short?)`);
  }
  const personaLockPrefix = composePersonaLockPrefix(entry.persona);

  // 3. Render each clip sequentially. Sequential (not parallel) inside
  //    a variation so an early-clip failure short-circuits before we
  //    burn credits on the remainder — the concat only makes sense if
  //    every clip renders.
  const clipUrls: string[] = [];
  let creditsSpent = 0;
  let clipsSucceeded = 0;
  for (let clipIndex = 0; clipIndex < clipDialogues.length; clipIndex++) {
    const dialogue = clipDialogues[clipIndex]!;
    const clipPrompt = composeClipPrompt({
      personaLockPrefix,
      clipDialogue: dialogue,
      clipIndex,
      totalClips: clipDialogues.length,
    });
    const clipResult = await guardedStepRun(step, `clip-${stepSuffix}-${clipIndex}`, async () => {
      try {
        const r = await runSeedanceCreditedJob({
          userId,
          modelId,
          dreaminaAccount,
          prompt: clipPrompt,
          referenceImage: { url: character.publicUrl },
          aspectRatio,
          durationSeconds: SEEDANCE_CLIP_SECONDS,
          generationJobId: jobId,
        });
        return safeInngestStepReturn({ kind: 'result' as const, result: r });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return safeInngestStepReturn({
            kind: 'insufficient_credits' as const,
            required: err.required,
            available: err.available,
          });
        }
        throw err;
      }
    });
    if (clipResult.kind === 'insufficient_credits') {
      return {
        index,
        ok: false,
        errorMessage: `Insufficient credits at clip ${clipIndex + 1}/${clipDialogues.length}: needed ${clipResult.required}, had ${clipResult.available}. ${clipsSucceeded} clips rendered successfully. Top up on /settings/credits.`,
        creditsSpent,
        clipsSucceeded,
        clipsTotal: clipDialogues.length,
      };
    }
    const seedance = clipResult.result;
    if (seedance.ok !== true) {
      return {
        index,
        ok: false,
        errorMessage: `Clip ${clipIndex + 1}/${clipDialogues.length} failed (${seedance.reason}): ${seedance.errorMessage}. ${clipsSucceeded} earlier clips rendered.`,
        creditsSpent,
        clipsSucceeded,
        clipsTotal: clipDialogues.length,
      };
    }
    clipUrls.push(seedance.videoUrl);
    creditsSpent += seedance.creditsSpent;
    clipsSucceeded++;
  }

  // 4. Concat the M clips via Replicate ffmpeg.
  const concat = await guardedStepRun(step, `concat-${stepSuffix}`, async () => {
    const submit = await submitReplicateConcat({
      userId,
      apiKey: keys.kling,
      videoUrls: clipUrls,
      generationJobId: jobId,
    });
    if (!submit.ok || !submit.predictionId) {
      throw new Error(`Replicate concat submit failed: ${submit.errorMessage ?? 'unknown'}`);
    }
    return safeInngestStepReturn({ predictionId: submit.predictionId });
  });

  // 5. Poll concat until done. Each attempt is its own step for
  //    per-tick Inngest retry + memoization.
  let concatUrl: string | null = null;
  for (let attempt = 0; attempt < CONCAT_POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0)
      await step.sleep(`concat-wait-${stepSuffix}-${attempt}`, `${CONCAT_POLL_INTERVAL_SECONDS}s`);
    const poll = await guardedStepRun(step, `concat-poll-${stepSuffix}-${attempt}`, async () => {
      const r = await checkReplicateConcat({
        userId,
        apiKey: keys.kling,
        predictionId: concat.predictionId,
        generationJobId: jobId,
      });
      return safeInngestStepReturn(r);
    });
    if (poll.status === 'completed' && poll.videoUrl) {
      concatUrl = poll.videoUrl;
      break;
    }
    if (poll.status === 'failed') {
      throw new Error(`Replicate concat failed: ${poll.errorMessage ?? 'unknown'}`);
    }
  }
  if (!concatUrl) {
    throw new Error(
      `Replicate concat did not complete in ${(CONCAT_POLL_MAX_ATTEMPTS * CONCAT_POLL_INTERVAL_SECONDS) / 60} minutes`,
    );
  }

  // 6. Store composite in our bucket.
  const stored = await guardedStepRun(step, `store-composite-${stepSuffix}`, async () => {
    try {
      const r = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: concatUrl!,
        filename: `polish29-seedance-var-${jobId}-${index}.mp4`,
      });
      return safeInngestStepReturn({ kind: 'ok' as const, publicUrl: r.publicUrl });
    } catch (err) {
      return safeInngestStepReturn({
        kind: 'err' as const,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  });
  const finalUrl = stored.kind === 'ok' ? stored.publicUrl : concatUrl;

  // 7. Persist the creative row.
  await guardedStepRun(step, `persist-${stepSuffix}`, async () => {
    const db = getDb();
    await db.insert(schema.generatedCreatives).values({
      userId,
      generationJobId: jobId,
      fileUrl: finalUrl,
      aspectRatio,
      status: 'ready',
      format: 'polish29_seedance_variations',
      hookVariantIndex: index,
      bodyVariantIndex: index,
      ctaVariantIndex: index,
      headline: (entry.persona.age_range + ' ' + entry.persona.gender).slice(0, 200),
      primaryText: entry.script.slice(0, 500),
      generationMetadata: {
        polish29_seedance: true,
        variant_index: index,
        model_id: modelId,
        credits_spent: creditsSpent,
        clips_total: clipDialogues.length,
        clip_urls_dreamina: clipUrls,
        composite_source_url: concatUrl,
        composite_supabase_ok: stored.kind === 'ok',
        composite_supabase_error: stored.kind === 'err' ? stored.errorMessage : null,
        persona: entry.persona,
        character_reference_url: character.publicUrl,
      },
    });
    // Silence a stray unused-var lint if Buffer isn't touched
    // elsewhere: keep the import so future clip-side pre-processing
    // (crop, resize) has ready access.
    void Buffer;
    return safeInngestStepReturn({ ok: true });
  });

  return {
    index,
    ok: true,
    compositeUrl: finalUrl,
    creditsSpent,
    clipsSucceeded,
    clipsTotal: clipDialogues.length,
  };
}
