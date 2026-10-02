/**
 * Polish-30.0.0 Commit 172: HeyGen Video 1.0 UGC variations worker.
 *
 * ONE API call per clip. HeyGen Video 1.0 does subject + setting +
 * sound + lip-sync in a single pass — no Nano-Banana-seed → Omni-seed-
 * clip → V2V-extend chain, no Dreamina credit-reserve dance, no
 * Google-Flow concat round-trip. This is the simplification the user
 * explicitly asked for ("we need to find 1 simple API and focus on it").
 *
 * Value prop (unchanged from polish29/polish30):
 *   1. User uploaded a winning ad (any length).
 *   2. Vision analysis extracted persona + script structure.
 *   3. Claude generates N distinct persona+script pairs.
 *   4. For each variation:
 *        - Nano Banana Pro renders ONE character still (the visual
 *          anchor for every clip of this variation).
 *        - Upload that still to HeyGen as an asset_id.
 *        - Split the script into M ~8s chunks at sentence boundaries.
 *        - For each chunk: HeyGen Video 1.0 reference_to_video with
 *          the character asset + per-chunk prose prompt. Native TTS +
 *          lip-sync come free in the same call.
 *        - Local ffmpeg trim+concat (Replicate fallback) stitches the
 *          M clips into one composite.
 *        - Upload composite → persist creative row.
 *
 * BYOK requirement: Claude (persona+script batch), Gemini (Nano Banana
 * Pro char still), HeyGen (video 1.0 render), Replicate (ffmpeg concat
 * fallback when Vercel doesn't bundle ffmpeg). Four BYOK — but each one
 * is already a required key from one of the surviving pipelines so no
 * new provider connections for existing users.
 *
 * Cost example (1 variation, 60s source → ~7 clips × 8s):
 *   $0.05 Claude batch
 *   $0.13 Nano Banana Pro character
 *   7 × 8s × $0.01/sec = $0.56 HeyGen clips (promo rate through Oct 2026)
 *   $0.02 concat
 *   = ~$0.76 per 60s variation at promo pricing. $1.17 at standard.
 */
import { Buffer } from 'node:buffer';
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  checkReplicateConcat,
  cloneCharacterReferenceImage,
  composeNanoBananaCharacterClonePrompt,
  pollHeygenVideo1,
  submitHeygenVideo1,
  submitReplicateConcat,
  uploadHeygenV1Asset,
  type HeygenVideo1DurationSeconds,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION } from '@mbb/shared';
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
import { buildUgcClipProse } from '../lib/ugc-prose-prompt';
import { uploadGeneratedImage, uploadGeneratedVideoFromBuffer } from '../lib/storage';
import { trimAndConcatVideos } from '../lib/video-compress';

console.log(`[jobs.generate-polish31-heygen-video] cold start — POLISH_VERSION=${POLISH_VERSION}`);

// -----------------------------------------------------------------
// Constants
// -----------------------------------------------------------------

const MAX_VARIANTS_PER_JOB = 10;
/** Polish-30.0.9 Commit 181: 8s → 15s per clip. HeyGen Video 1.0's
 *  max per-call duration is 15s; using the max cuts clip count by
 *  ~2× for the same composite length, which halves concat workload
 *  and the number of join seams where voice/face drift can show up. */
const HEYGEN_V1_CLIP_SECONDS: HeygenVideo1DurationSeconds = 15;
const MAX_CLIPS_PER_VARIANT = 20; // 300s = 5min composite ceiling
const MIN_CLIPS_PER_VARIANT = 1;
const DEFAULT_CLIPS_PER_VARIANT = 2;
/** Target words per 15s clip at 3 wps (HeyGen docs: "Written
 *  dialogue fits at roughly 2.5 words per second"). We lean slightly
 *  denser (3 wps) to match the UGC-prose-prompt tuning. */
const WORDS_PER_CLIP = 45;

/** HeyGen poll: typical render ~1-3 min at 768p. */
const HEYGEN_POLL_INTERVAL_SECONDS = 10;
const HEYGEN_POLL_MAX_ATTEMPTS = 30; // 5 min ceiling

/** ffmpeg trim offsets at clip joins — same values Omni's server-side
 *  concat uses, proven to hide 1.4s of per-join silence on real UGC. */
const CONCAT_TRIM_END_SECONDS = 0.375;
const CONCAT_TRIM_START_SECONDS = 0.458;

export interface Polish31HeygenVideoEventPayload {
  jobId: string;
  userId: string;
  resolution?: '480p' | '768p';
  aspectRatio?: '9:16' | '1:1' | '16:9';
}

// -----------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

export function pickClipCountForSourceDuration(sourceSeconds: number | null): number {
  if (!sourceSeconds || sourceSeconds <= 0 || !Number.isFinite(sourceSeconds)) {
    return DEFAULT_CLIPS_PER_VARIANT;
  }
  const raw = Math.round(sourceSeconds / HEYGEN_V1_CLIP_SECONDS);
  return Math.max(MIN_CLIPS_PER_VARIANT, Math.min(MAX_CLIPS_PER_VARIANT, raw));
}

export function pickScriptWordTarget(sourceSeconds: number | null): number {
  const seconds =
    typeof sourceSeconds === 'number' && Number.isFinite(sourceSeconds) && sourceSeconds > 0
      ? sourceSeconds
      : 30;
  const clipCount = Math.max(
    MIN_CLIPS_PER_VARIANT,
    Math.min(MAX_CLIPS_PER_VARIANT, Math.round(seconds / HEYGEN_V1_CLIP_SECONDS)),
  );
  return clipCount * WORDS_PER_CLIP;
}

/** Sentence-boundary chunker. Lifted from polish29 Commit 136 — proven
 *  on real UGC audio to pace naturally in TTS-driven generators. */
export function splitScriptIntoClips(script: string, targetClipCount: number): string[] {
  const trimmed = script.trim();
  if (!trimmed) return [];
  const sentenceMatches = trimmed.match(/[^.!?]+[.!?]+/g);
  const sentences =
    sentenceMatches && sentenceMatches.length > 0
      ? sentenceMatches.map((s) => s.trim()).filter(Boolean)
      : [trimmed];
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;
  const wordCountOf = (s: string) => s.split(/\s+/).filter(Boolean).length;
  for (const sentence of sentences) {
    const sw = wordCountOf(sentence);
    if (sw > Math.ceil(WORDS_PER_CLIP * 1.5)) {
      if (current.length > 0) {
        chunks.push(current.join(' '));
        current = [];
        currentWordCount = 0;
      }
      const words = sentence.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += WORDS_PER_CLIP) {
        const sub = words.slice(i, i + WORDS_PER_CLIP).join(' ');
        chunks.push(/[.!?]$/.test(sub) ? sub : sub + '.');
      }
      continue;
    }
    if (currentWordCount + sw > WORDS_PER_CLIP && current.length > 0) {
      chunks.push(current.join(' '));
      current = [];
      currentWordCount = 0;
    }
    current.push(sentence);
    currentWordCount += sw;
  }
  if (current.length > 0) chunks.push(current.join(' '));
  while (chunks.length > MAX_CLIPS_PER_VARIANT) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] = chunks[chunks.length - 1] + ' ' + last;
  }
  const clamped = Math.max(MIN_CLIPS_PER_VARIANT, Math.min(MAX_CLIPS_PER_VARIANT, targetClipCount));
  void clamped;
  return chunks;
}

/** Per-clip HeyGen Video 1.0 prose prompt. Uses the shared
 *  buildUgcClipProse builder — same prose the Seedance + Omni paths
 *  landed on. HeyGen's prompt format accepts natural-language prose
 *  without any provider-specific markers (no curly-brace dialogue, no
 *  @image references). We quote the dialogue line inline. */
export function composeHeygenV1ClipPrompt(
  dialogue: string,
  persona: Polish28VariationEntry['persona'],
): string {
  const cleaned = dialogue.replace(/\s+/g, ' ').trim();
  const prose = buildUgcClipProse({
    persona,
    cameraMode: 'selfie',
    clipSeconds: HEYGEN_V1_CLIP_SECONDS,
    targetWordsPerSecond: 3,
  });
  return prose.replace('__DIALOGUE__', `"${cleaned}"`);
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
    'polish31-heygen-video:patchMetadata',
  );
  await db
    .update(schema.generationJobs)
    .set({ metadata: cleaned })
    .where(eq(schema.generationJobs.id, jobId));
}

// -----------------------------------------------------------------
// Poll helper
// -----------------------------------------------------------------

async function pollHeygenV1UntilComplete(input: {
  userId: string;
  apiKey: string;
  videoId: string;
  generationJobId: string;
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  stepLabel: string;
}): Promise<
  | { ok: true; videoUrl: string; attempts: number }
  | { ok: false; errorMessage: string; attempts: number }
> {
  let attempts = 0;
  for (let i = 0; i < HEYGEN_POLL_MAX_ATTEMPTS; i++) {
    attempts = i + 1;
    if (i > 0) {
      await input.step.sleep(`${input.stepLabel}-wait-${i}`, `${HEYGEN_POLL_INTERVAL_SECONDS}s`);
    }
    const poll = await guardedStepRun(input.step, `${input.stepLabel}-poll-${i}`, async () => {
      const r = await pollHeygenVideo1({
        userId: input.userId,
        apiKey: input.apiKey,
        videoId: input.videoId,
        generationJobId: input.generationJobId,
      });
      return safeInngestStepReturn({
        status: r.status,
        videoUrl: r.videoUrl,
        errorMessage: r.errorMessage,
        rawStatus: r.rawStatus,
      });
    });
    if (poll.status === 'completed') {
      if (!poll.videoUrl) {
        return { ok: false, errorMessage: 'completed but no video_url', attempts };
      }
      return { ok: true, videoUrl: poll.videoUrl, attempts };
    }
    if (poll.status === 'failed') {
      return { ok: false, errorMessage: poll.errorMessage ?? 'poll failed', attempts };
    }
  }
  return {
    ok: false,
    errorMessage: `did not complete after ${HEYGEN_POLL_MAX_ATTEMPTS} polls (${
      (HEYGEN_POLL_MAX_ATTEMPTS * HEYGEN_POLL_INTERVAL_SECONDS) / 60
    } min)`,
    attempts,
  };
}

// -----------------------------------------------------------------
// Inngest worker
// -----------------------------------------------------------------

export const generatePolish31HeygenVideo = inngest.createFunction(
  {
    id: 'generate-polish31-heygen-video',
    name: 'Polish-31: HeyGen Video 1.0 UGC variations',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish31-heygen-video.requested' },
  async ({ event, step }) => {
    const data = event.data as Polish31HeygenVideoEventPayload;
    const startedAt = Date.now();
    const jobUserId = assertScalarDefinedForPostgres(
      data.userId,
      'userId',
      'polish31-heygen-video:entry',
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
        'polish31 HeyGen Video 1.0 requires a concept with vision-analyzed metadata. ' +
        'Upload the source ad and re-run analyze-concept first.';
      await markJobFailed(data.jobId, jobUserId, msg, 0);
      throw new NonRetriableError(msg);
    }
    const requestedVariantCount = Math.max(
      1,
      Math.min(MAX_VARIANTS_PER_JOB, job.variantCount ?? 1),
    );

    const jobMetadata = (job.metadata ?? {}) as Record<string, unknown>;
    const metaResolution =
      typeof jobMetadata['resolution'] === 'string'
        ? (jobMetadata['resolution'] as string)
        : undefined;
    const metaAspectRatio =
      typeof jobMetadata['aspect_ratio'] === 'string'
        ? (jobMetadata['aspect_ratio'] as string)
        : undefined;
    const resolutionCandidate = data.resolution ?? metaResolution ?? '768p';
    const resolution: '480p' | '768p' = resolutionCandidate === '480p' ? '480p' : '768p';
    const aspectRatioCandidate = data.aspectRatio ?? metaAspectRatio ?? '9:16';
    const aspectRatio: '9:16' | '1:1' | '16:9' =
      aspectRatioCandidate === '1:1' ? '1:1' : aspectRatioCandidate === '16:9' ? '16:9' : '9:16';

    // ---------- B: mark processing ----------
    await guardedStepRun(step, 'mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, data.jobId));
      await patchMetadata(data.jobId, {
        polish25_progress: { step: 'mark-processing', at: nowIso() },
        polish31_heygen_video_start: {
          resolution,
          aspect_ratio: aspectRatio,
          variant_count_requested: requestedVariantCount,
          at: nowIso(),
        },
      });
      return safeInngestStepReturn({ ok: true });
    });

    // ---------- C: preflight BYOK (Claude + Gemini + HeyGen + Replicate) ----------
    const keys = await guardedStepRun(step, 'preflight-byok', async () => {
      try {
        const loaded = await loadDecryptedKeys(jobUserId, ['claude', 'gemini', 'heygen', 'kling']);
        if (!loaded.claude) throw new MissingProviderKeyError('claude');
        if (!loaded.gemini) throw new MissingProviderKeyError('gemini');
        if (!loaded.heygen) throw new MissingProviderKeyError('heygen');
        if (!loaded.kling) throw new MissingProviderKeyError('kling');
        return safeInngestStepReturn({
          claude: loaded.claude,
          gemini: loaded.gemini,
          heygen: loaded.heygen,
          kling: loaded.kling,
        });
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          const msg =
            `HeyGen Video 1.0 needs 4 BYOK keys (Claude + Gemini + HeyGen + Replicate). ` +
            `Missing: ${err.message}. Connect at /settings/connections.`;
          await markJobFailed(data.jobId, jobUserId, msg, 0);
          throw new NonRetriableError(msg);
        }
        throw err;
      }
    });

    // ---------- D: load concept + vision analysis ----------
    const source = await guardedStepRun(step, 'load-source-context', async () => {
      const db = getDb();
      const concept = await db.query.concepts.findFirst({
        where: eq(schema.concepts.id, conceptId),
        columns: { metadata: true, ugcOriginalScript: true },
      });
      if (!concept) {
        const msg = `polish31 HeyGen Video 1.0: concept ${conceptId} not found.`;
        await markJobFailed(data.jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
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
        const msg =
          `Concept ${conceptId} has no vision-analyzed metadata or usable original script. ` +
          `Re-run analyze-concept on this concept before submitting.`;
        await markJobFailed(data.jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }
      const scriptWordTarget = pickScriptWordTarget(source.sourceSeconds);
      const userPrompt = composePolish28VariationsUserPrompt(
        rawInput,
        requestedVariantCount,
        scriptWordTarget,
      );
      const r = await callClaude({
        userId: jobUserId,
        apiKey: keys.claude,
        systemPrompt: POLISH28_VARIATIONS_SYSTEM_PROMPT,
        cacheSystemPrompt: true,
        userMessage: userPrompt,
        maxTokens: 16000,
        generationJobId: data.jobId,
      });
      if (!r.ok || !r.text || r.text.trim().length === 0) {
        const msg = `Claude batch call failed: ${r.errorMessage ?? 'empty response'}`;
        await markJobFailed(data.jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }
      const parsed = parsePolish28VariationsResponse(r.text);
      if (parsed.entries.length === 0) {
        const msg = `Claude returned 0 valid persona+script entries. Errors: ${parsed.errors.slice(0, 5).join(' | ')}`;
        await markJobFailed(data.jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }
      await patchMetadata(data.jobId, {
        polish25_progress: { step: 'submitted', at: nowIso() },
        polish31_heygen_video_batch: {
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
          resolution,
          aspectRatio,
          clipsPerVariant,
          keys,
        }).catch((err) => {
          console.error(`[polish31-heygen-video] variation ${index} failed:`, err);
          return {
            index,
            ok: false as const,
            errorMessage: err instanceof Error ? err.message : String(err),
            clipsSucceeded: 0,
            clipsTotal: clipsPerVariant,
          };
        }),
      ),
    );

    const successful = variantResults.filter((r) => r.ok);
    const failed = variantResults.filter((r) => !r.ok);

    // ---------- G: mark completed ----------
    await guardedStepRun(step, 'mark-completed-status', async () => {
      const db = getDb();
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
      return safeInngestStepReturn({ ok: true });
    });
    await guardedStepRun(step, 'mark-completed-metadata', async () => {
      const durationMs = Date.now() - startedAt;
      await patchMetadata(data.jobId, {
        polish25_progress: { step: 'video-ready', at: nowIso() },
        polish31_heygen_video_summary: {
          requested: variations.entries.length,
          succeeded: successful.length,
          failed: failed.length,
          clips_per_variant: clipsPerVariant,
          resolution,
          aspect_ratio: aspectRatio,
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
    };
  },
);

// -----------------------------------------------------------------
// Per-variation renderer
// -----------------------------------------------------------------

interface RenderOneVariationInput {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  index: number;
  entry: Polish28VariationEntry;
  jobId: string;
  userId: string;
  resolution: '480p' | '768p';
  aspectRatio: '9:16' | '1:1' | '16:9';
  clipsPerVariant: number;
  keys: { claude: string; gemini: string; heygen: string; kling: string };
}

type RenderOneVariationResult =
  | {
      index: number;
      ok: true;
      compositeUrl: string;
      clipsSucceeded: number;
      clipsTotal: number;
    }
  | {
      index: number;
      ok: false;
      errorMessage: string;
      clipsSucceeded: number;
      clipsTotal: number;
    };

async function renderOneVariation(
  input: RenderOneVariationInput,
): Promise<RenderOneVariationResult> {
  const { step, index, entry, jobId, userId, resolution, aspectRatio, keys } = input;
  const stepSuffix = `v${index}`;
  // Polish-30.0.9 Commit 181: fixed random seed PER variation shared
  // across every clip's HeyGen submit. HeyGen docs: "Hold the seed and
  // change one clause at a time to iterate." Using one seed for every
  // clip in a variation means the model samples from the same noise
  // base for each render, which materially tightens voice timbre,
  // face continuity, and lighting consistency across clip joins —
  // the single biggest quality lever beyond the reference image.
  // Random per variation (so variants still differ from each other)
  // and derived once outside the clip loop (so it's identical across
  // the 2-20 clips in one variation).
  const variationSeed = Math.floor(Math.random() * 0x7fffffff);

  // 1. Nano Banana Pro character still — the visual anchor fed to
  //    every HeyGen clip as reference_images[0].
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
    const mimeType = r.imageMimeType ?? 'image/png';
    const uploaded = await uploadGeneratedImage({
      userId,
      jobId,
      variantIndex: index,
      imageBase64: r.imageBase64,
      mimeType,
      filenamePrefix: `polish31-var${index}-character-`,
    });
    return safeInngestStepReturn({
      publicUrl: uploaded.publicUrl,
      mimeType,
      base64: r.imageBase64,
    });
  });

  // 2. Upload the character still to HeyGen as an asset_id. All clips
  //    in this variation reference this one asset for face consistency.
  const heygenAsset = await guardedStepRun(step, `char-upload-${stepSuffix}`, async () => {
    const buffer = Buffer.from(character.base64, 'base64');
    const r = await uploadHeygenV1Asset({
      userId,
      apiKey: keys.heygen,
      buffer,
      filename: `polish31-var${index}-character.png`,
      contentType: character.mimeType,
      generationJobId: jobId,
    });
    if (!r.ok || !r.assetId) {
      throw new Error(`HeyGen asset upload failed: ${r.errorMessage ?? 'unknown'}`);
    }
    return safeInngestStepReturn({ assetId: r.assetId });
  });

  // 3. Split the script into M clip chunks.
  const clipDialogues = splitScriptIntoClips(entry.script, input.clipsPerVariant);
  if (clipDialogues.length === 0) {
    throw new Error(`variation ${index}: script split produced 0 clips (script too short?)`);
  }

  // 4. For each clip: HeyGen Video 1.0 reference_to_video.
  const clipUrls: string[] = [];
  const clipFailures: Array<{ clipIndex: number; errorMessage: string }> = [];
  let clipsSucceeded = 0;
  for (let clipIndex = 0; clipIndex < clipDialogues.length; clipIndex++) {
    // Polish-29.0.62 Commit 171 lesson preserved — soft lead-in filler
    // ("So,") on the first clip prevents HeyGen's TTS attack window
    // from eating the opening real content.
    const rawDialogue = clipDialogues[clipIndex]!;
    const dialogue = clipIndex === 0 ? `So, ${rawDialogue}` : rawDialogue;
    const clipPrompt = composeHeygenV1ClipPrompt(dialogue, entry.persona);
    // Polish-30.0.3 Commit 175: inline retry around the submit call.
    // Transient 60s timeouts on HeyGen's /v3/models/videos endpoint
    // under load took down the first full-13-clip test even though
    // every clip rendered the same way — a single transient blip at
    // the top of the chain tore everything down. 2 attempts with a
    // 5s backoff covers the "HeyGen was slow for a moment" class
    // without extending wall-clock for genuine failures (the retry
    // only runs when attempt 1 fails).
    const submitResult = await guardedStepRun(
      step,
      `clip-submit-${stepSuffix}-${clipIndex}`,
      async () => {
        const SUBMIT_RETRY_DELAYS_MS = [0, 5_000];
        let lastResult: Awaited<ReturnType<typeof submitHeygenVideo1>> | null = null;
        for (let attempt = 0; attempt < SUBMIT_RETRY_DELAYS_MS.length; attempt++) {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, SUBMIT_RETRY_DELAYS_MS[attempt]!));
          }
          const r = await submitHeygenVideo1({
            userId,
            apiKey: keys.heygen,
            prompt: clipPrompt,
            mode: 'reference_to_video',
            durationSeconds: HEYGEN_V1_CLIP_SECONDS,
            resolution,
            aspectRatio,
            referenceImages: [{ assetId: heygenAsset.assetId }],
            // Polish-30.0.9 Commit 181: variation-wide fixed seed for
            // cross-clip consistency.
            seed: variationSeed,
            generationJobId: jobId,
          });
          lastResult = r;
          if (r.ok && r.videoId) break;
          // 4xx schema errors won't change on retry — bail fast.
          const bodyLooksTransient =
            !r.errorMessage ||
            r.errorMessage.includes('timed out') ||
            r.errorMessage.includes('HTTP 5') ||
            r.errorMessage.includes('ECONNRESET');
          if (!bodyLooksTransient) break;
        }
        return safeInngestStepReturn({
          ok: lastResult?.ok ?? false,
          videoId: lastResult?.videoId,
          errorMessage: lastResult?.errorMessage,
        });
      },
    );
    if (!submitResult.ok || !submitResult.videoId) {
      clipFailures.push({
        clipIndex,
        errorMessage: submitResult.errorMessage ?? 'no videoId',
      });
      continue;
    }
    const pollResult = await pollHeygenV1UntilComplete({
      userId,
      apiKey: keys.heygen,
      videoId: submitResult.videoId,
      generationJobId: jobId,
      step,
      stepLabel: `clip-poll-${stepSuffix}-${clipIndex}`,
    });
    if (!pollResult.ok) {
      clipFailures.push({ clipIndex, errorMessage: pollResult.errorMessage });
      continue;
    }
    clipUrls.push(pollResult.videoUrl);
    clipsSucceeded++;
  }

  if (clipsSucceeded < MIN_CLIPS_PER_VARIANT) {
    const failureSummary = clipFailures
      .slice(0, 3)
      .map((f) => `clip ${f.clipIndex + 1}: ${f.errorMessage.slice(0, 120)}`)
      .join(' | ');
    return {
      index,
      ok: false,
      errorMessage: `Only ${clipsSucceeded}/${clipDialogues.length} clips rendered — need at least ${MIN_CLIPS_PER_VARIANT}. Failures: ${failureSummary}`,
      clipsSucceeded,
      clipsTotal: clipDialogues.length,
    };
  }

  // 5. Trim + concat + upload — same local-ffmpeg-with-Replicate-fallback
  //    pattern polish29 landed on (Commits 165/166). All in ONE step so
  //    multi-MB clip buffers stay under Inngest's 4MB step-return cap.
  const stored = await guardedStepRun(step, `local-concat-and-store-${stepSuffix}`, async () => {
    const clipBuffers: Array<{ buffer: Buffer; trimStart?: number; trimEnd?: number }> = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const url = clipUrls[i]!;
      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        return safeInngestStepReturn({
          kind: 'err' as const,
          errorMessage: `Fetch clip ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (!res.ok) {
        return safeInngestStepReturn({
          kind: 'err' as const,
          errorMessage: `Fetch clip ${i} failed: HTTP ${res.status}`,
        });
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      clipBuffers.push({
        buffer,
        ...(i > 0 ? { trimStart: CONCAT_TRIM_START_SECONDS } : {}),
        ...(i < clipUrls.length - 1 ? { trimEnd: CONCAT_TRIM_END_SECONDS } : {}),
      });
    }
    let concatResult = await trimAndConcatVideos(clipBuffers);
    if (!concatResult.wasConcatenated) {
      console.log(
        `[polish31-heygen-video] local ffmpeg unavailable ` +
          `(${concatResult.error ?? 'unknown'}); falling back to Replicate concat.`,
      );
      const submit = await submitReplicateConcat({
        userId,
        apiKey: keys.kling,
        videoUrls: clipUrls,
        generationJobId: jobId,
      });
      if (!submit.ok || !submit.predictionId) {
        return safeInngestStepReturn({
          kind: 'err' as const,
          errorMessage: `Replicate concat submit failed: ${submit.errorMessage ?? 'unknown'}`,
        });
      }
      let replicateUrl: string | null = null;
      // Polish-30.0.8 Commit 180: bumped poll ceiling 36 (3 min) →
      // 60 (5 min). A 11-clip composite at 768p is ~55 MB of input
      // video; Replicate's stream-copy concat typically runs 3-5 min
      // on a payload that size, so 3 min was too tight — first fully
      // successful HeyGen render (all 11 clips rendered) died here.
      // 5 min is the ceiling for Vercel Pro's function timeout, so
      // this is also the practical max before we'd need to split the
      // concat poll across step.sleep boundaries.
      const CONCAT_POLL_MAX = 60;
      const CONCAT_POLL_INTERVAL_MS = 5000;
      for (let attempt = 0; attempt < CONCAT_POLL_MAX; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, CONCAT_POLL_INTERVAL_MS));
        const poll = await checkReplicateConcat({
          userId,
          apiKey: keys.kling,
          predictionId: submit.predictionId,
          generationJobId: jobId,
        });
        if (poll.status === 'completed' && poll.videoUrl) {
          replicateUrl = poll.videoUrl;
          break;
        }
        if (poll.status === 'failed') {
          return safeInngestStepReturn({
            kind: 'err' as const,
            errorMessage: `Replicate concat failed: ${poll.errorMessage ?? 'unknown'}`,
          });
        }
      }
      if (!replicateUrl) {
        return safeInngestStepReturn({
          kind: 'err' as const,
          errorMessage: `Replicate concat did not complete in ~3 min`,
        });
      }
      try {
        const dl = await fetch(replicateUrl);
        if (!dl.ok) throw new Error(`Replicate concat URL HTTP ${dl.status}`);
        const buffer = Buffer.from(await dl.arrayBuffer());
        concatResult = {
          buffer,
          wasConcatenated: true,
          totalBytes: buffer.byteLength,
          concatMs: 0,
        };
      } catch (err) {
        return safeInngestStepReturn({
          kind: 'err' as const,
          errorMessage: `Fetch Replicate concat result failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    try {
      const upload = await uploadGeneratedVideoFromBuffer({
        userId,
        jobId,
        buffer: concatResult.buffer,
        filename: `polish31-heygen-video-${jobId}-${index}.mp4`,
      });
      return safeInngestStepReturn({ kind: 'ok' as const, publicUrl: upload.publicUrl });
    } catch (err) {
      return safeInngestStepReturn({
        kind: 'err' as const,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  });
  if (stored.kind !== 'ok') {
    throw new Error(`polish31 composite upload failed: ${stored.errorMessage}`);
  }
  const finalUrl = stored.publicUrl;

  // 6. Persist the creative row.
  await guardedStepRun(step, `persist-${stepSuffix}`, async () => {
    const db = getDb();
    // generated_creatives.aspect_ratio schema only accepts 9:16 | 1:1 | 4:5.
    // Narrow 16:9 → 9:16 at the row boundary (we never actually ship 16:9
    // today; the HeyGen submit column still carries whatever the user picked).
    const persistAspect: '9:16' | '1:1' = aspectRatio === '1:1' ? '1:1' : '9:16';
    await db.insert(schema.generatedCreatives).values({
      userId,
      generationJobId: jobId,
      fileUrl: finalUrl,
      aspectRatio: persistAspect,
      status: 'ready',
      format: 'polish31_heygen_video',
      hookVariantIndex: index,
      bodyVariantIndex: index,
      ctaVariantIndex: index,
      headline: (entry.persona.age_range + ' ' + entry.persona.gender).slice(0, 200),
      primaryText: entry.script.slice(0, 500),
      generationMetadata: {
        polish31_heygen_video: true,
        variant_index: index,
        resolution,
        clip_seconds: HEYGEN_V1_CLIP_SECONDS,
        variation_seed: variationSeed,
        clips_total: clipDialogues.length,
        clips_succeeded: clipsSucceeded,
        clip_urls_heygen: clipUrls,
        clip_failures: clipFailures,
        heygen_asset_id: heygenAsset.assetId,
        character_reference_url: character.publicUrl,
        persona: entry.persona,
      },
    });
    return safeInngestStepReturn({ ok: true });
  });

  return {
    index,
    ok: true,
    compositeUrl: finalUrl,
    clipsSucceeded,
    clipsTotal: clipDialogues.length,
  };
}
