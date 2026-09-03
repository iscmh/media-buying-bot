/**
 * Polish-29.0.38 Commit 147: Google Flow / Omni 1.1 Flash variations
 * worker — the cheaper sibling of polish29_seedance_variations.
 *
 * Value prop:
 *   1. User uploaded a winning ad (any length; typical 30-60s).
 *   2. Vision analysis extracted persona + script structure.
 *   3. Claude generates N distinct persona+script pairs (same
 *      composePolish28VariationsUserPrompt as the Seedance path).
 *   4. For each variation, per the useapi.net "Extend Omni 1.1 Flash
 *      Videos — UGC Talking Head" blog:
 *        - Nano Banana 2 Lite renders ONE still of the persona (0
 *          Google Flow credits). Portrait, at rest, looking into lens.
 *        - Seed clip: Omni 1.1 Flash 4s I2V with startImage = endImage
 *          = same still (7 Flow credits). The clip begins and ends on
 *          the still with free motion in the middle — matching pin
 *          frames make later joins invisible.
 *        - Extend chain: for each remaining script chunk, submit an
 *          Omni V2V edit taking the previous clip as referenceVideo_1
 *          (20 Flow credits per extend). Omni inherits the seed's
 *          voice, motion, camera, framing; the new prompt supplies
 *          the next dialogue.
 *        - Concatenate: Google Flow /videos/concatenate joins all
 *          clips with per-segment trimStart/trimEnd to cut the
 *          pin-frame quiet beats at the joins (0 credits).
 *        - Store composite → persist creative row.
 *
 * BYOK requirement: ONLY Claude (persona+script batch). Nano Banana +
 * Omni + concat all run through the platform-side registered Google
 * Flow account. Zero HeyGen / Gemini / Replicate BYOK — a 3× reduction
 * vs the polish29 Seedance path.
 *
 * Cost example (1 variation, source ad ~10s → 3 clips per variant):
 *   0 (still) + 7 (seed) + 2 × 20 (extends) + 0 (concat) = 47 Flow
 *   credits per variation = ~$0.47 at Google AI Ultra tier ($0.01/credit)
 *   or ~$1.88 at Plus tier ($0.04/credit). Plus a Claude batch call
 *   amortized across N variations (~$0.05 per batch).
 *
 * vs polish29 Seedance: ~137 Dreamina credits/clip × 3 = 411 credits =
 * $4.11 per variation. Omni path is ~9× cheaper at Ultra, ~2× at Plus.
 */
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  checkUseapiJob,
  submitGoogleFlowConcat,
  submitNanoBananaImage,
  submitOmniVideo,
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
import { uploadGeneratedVideoFromUrl } from '../lib/storage';

console.log(
  `[jobs.generate-polish30-omni-variations] cold start — POLISH_VERSION=${POLISH_VERSION}`,
);

// -----------------------------------------------------------------
// Constants
// -----------------------------------------------------------------

const MAX_VARIANTS_PER_JOB = 10;
/** Max clips per variation. Omni 4s clips × 10 = 40s composite cap. */
const MAX_CLIPS_PER_VARIANT = 10;
const MIN_CLIPS_PER_VARIANT = 2;
const DEFAULT_CLIPS_PER_VARIANT = 3;
/** Omni clip length. 4s = cheapest tier per Google Flow credit table. */
const OMNI_CLIP_SECONDS = 4;
/**
 * Words per 4s Omni clip. Blog says "about 8 words per 4-second clip"
 * before Omni truncates the audio. Keeping to 8 keeps the last words
 * of each clip from getting cut off.
 */
const WORDS_PER_CLIP = 8;
const MIN_SCRIPT_WORDS = 40;

// Google Flow's job-poll cadence per useapi.net docs: Omni 1.1 Flash
// typically completes in 40-70s. Poll every 8s for up to 3 min.
const OMNI_POLL_INTERVAL_SECONDS = 8;
const OMNI_POLL_MAX_ATTEMPTS = 24;

// Trim offsets for the concat step — cuts the pin-frame quiet beats
// at each join. From the useapi.net blog measurement: ~0.375s hold at
// clip end, ~0.458s hold at next clip start.
const CONCAT_TRIM_END_SECONDS = 0.375;
const CONCAT_TRIM_START_SECONDS = 0.458;

/**
 * Event payload. analyze-concept fans out with only {jobId, userId,
 * mode}; pipeline config comes from job.metadata + env var (same
 * pattern as polish29_seedance_variations).
 */
export interface Polish30OmniVariationsEventPayload {
  jobId: string;
  userId: string;
  googleFlowAccount?: string;
  resolution?: '360p' | '720p';
}

// -----------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Split a script into per-clip dialogue chunks at sentence boundaries,
 * grouping sentences until each chunk approaches WORDS_PER_CLIP words.
 * Same algorithm as polish29 Commit 136 — sentence-boundary chunks
 * pace naturally through Omni's TTS; mid-sentence fragments get rushed.
 */
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
  const clamped = Math.max(MIN_CLIPS_PER_VARIANT, Math.min(MAX_CLIPS_PER_VARIANT, targetClipCount));
  while (chunks.length > MAX_CLIPS_PER_VARIANT) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] = chunks[chunks.length - 1] + ' ' + last;
  }
  void clamped;
  return chunks;
}

export function pickClipCountForSourceDuration(sourceSeconds: number | null): number {
  if (!sourceSeconds || sourceSeconds <= 0 || !Number.isFinite(sourceSeconds)) {
    return DEFAULT_CLIPS_PER_VARIANT;
  }
  const raw = Math.round(sourceSeconds / OMNI_CLIP_SECONDS);
  return Math.max(MIN_CLIPS_PER_VARIANT, Math.min(MAX_CLIPS_PER_VARIANT, raw));
}

/**
 * The Nano Banana 2 Lite prompt for the seed still.
 * Per the useapi.net blog: portrait, at rest, looking into lens, hands
 * relaxed — a pose the persona can naturally return to (both ends of
 * every clip land on this frame).
 */
export function composeSeedStillPrompt(persona: Polish28VariationEntry['persona']): string {
  return [
    `A single 9:16 vertical portrait photo of a ${persona.age_range} ${persona.ethnicity} ${persona.gender}.`,
    `Look: ${persona.look}`,
    `Framing: medium close-up on face and upper chest, looking straight into the camera lens, mouth naturally closed at rest, hands relaxed and out of frame or in lap.`,
    `Aesthetic: candid iPhone front-camera selfie, casual home or apartment background, natural window light, no cinematic bokeh, no beauty smoothing, no filter, no color grading.`,
    `Full frame, no phone bezel, no border, no text, no captions, no watermarks.`,
  ].join(' ');
}

/**
 * Seed-clip prompt: the ~first line of the script + explicit rules
 * that the clip begins and ends on the reference still. Blog: allow
 * motion in the middle (leaning in, hand gestures, head tilt, laugh)
 * but pin both ends. Later V2V extends inherit this seed's voice +
 * mannerisms.
 */
export function composeSeedClipPrompt(
  persona: Polish28VariationEntry['persona'],
  firstDialogue: string,
): string {
  const cleaned = firstDialogue.replace(/\s+/g, ' ').trim();
  return [
    `A single 4-second UGC selfie video of a ${persona.age_range} ${persona.ethnicity} ${persona.gender}. Same person, same setting, same lighting as the reference image.`,
    ``,
    `CAMERA: static handheld phone camera, natural micro-wobble only, no zoom, no pan, no dolly, no tilt. Fixed medium close-up on face and upper chest.`,
    ``,
    `LOOK: amateur raw selfie video, unedited, no color grading, no cinematic bokeh. iPhone front-camera UGC aesthetic. Same clothing, same background, same window lighting as the reference image throughout.`,
    ``,
    `MOTION: the speaker starts on the reference frame, moves naturally through the clip — leaning slightly forward, one hand gesture, small head tilt, a small warm smile — and returns to the reference frame at the end. Both the FIRST and LAST frames of this clip must match the reference image exactly. Free motion in the middle.`,
    ``,
    `DELIVERY: natural conversational pace, around 120 words per minute. Warm sincere casual tone, direct to camera. Do not rush. Do not over-enunciate. Do not perform.`,
    ``,
    `The speaker says: "${cleaned}"`,
    ``,
    `Full frame, no phone bezel, no border, no text, no captions, no watermarks.`,
  ].join('\n');
}

/**
 * Extend-clip prompt: V2V edit inheriting the previous clip's voice +
 * motion + camera + framing, delivering the next dialogue line. Blog
 * pattern: first paragraph pins what must NOT change, quoted line is
 * the new content, last sentence keeps hands empty and strips captions.
 */
export function composeExtendClipPrompt(dialogue: string): string {
  const cleaned = dialogue.replace(/\s+/g, ' ').trim();
  return [
    `Same person as the reference video: same face, same clothing, same background, same lighting, same voice, same camera, same framing, same handheld micro-wobble. She begins and ends exactly as the reference video does — both first and last frames match the reference video's first and last frames.`,
    ``,
    `She says: "${cleaned}"`,
    ``,
    `Hands stay empty. Remove all text, captions, buttons, subtitles, and watermarks.`,
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
    'polish30-omni-variations:patchMetadata',
  );
  await db
    .update(schema.generationJobs)
    .set({ metadata: cleaned })
    .where(eq(schema.generationJobs.id, jobId));
}

// -----------------------------------------------------------------
// Poll helper — Google Flow uses /jobs/{jobid} for all types
// -----------------------------------------------------------------

async function pollUntilComplete(input: {
  userId: string;
  jobId: string;
  generationJobId?: string;
  maxAttempts: number;
  intervalSeconds: number;
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  stepLabel: string;
}): Promise<
  | { ok: true; videoUrl?: string; imageUrl?: string; mediaGenerationId?: string; attempts: number }
  | { ok: false; errorMessage: string; attempts: number }
> {
  let attempts = 0;
  for (let i = 0; i < input.maxAttempts; i++) {
    attempts = i + 1;
    if (i > 0) {
      await input.step.sleep(`${input.stepLabel}-wait-${i}`, `${input.intervalSeconds}s`);
    }
    const poll = await guardedStepRun(input.step, `${input.stepLabel}-poll-${i}`, async () => {
      const r = await checkUseapiJob({
        userId: input.userId,
        service: 'google-flow',
        jobId: input.jobId,
        generationJobId: input.generationJobId,
      });
      return safeInngestStepReturn(r);
    });
    if (poll.status === 'completed') {
      // Google Flow response shape: media[0].image.generatedImage.
      // mediaGenerationId or media[0].video... We rely on our earlier
      // extraction chain in normalizeJobBody (videoUrl / imageUrls[0]).
      // The mediaGenerationId is on the raw job body under different
      // paths per output type; extract from raw.
      const raw = (poll.raw ?? {}) as Record<string, unknown>;
      const media = extractMediaGenerationId(raw);
      return {
        ok: true,
        videoUrl: poll.videoUrl,
        imageUrl: poll.imageUrls?.[0],
        mediaGenerationId: media,
        attempts,
      };
    }
    if (poll.status === 'failed') {
      return { ok: false, errorMessage: poll.errorMessage ?? 'poll failed', attempts };
    }
  }
  return {
    ok: false,
    errorMessage: `did not complete after ${input.maxAttempts} polls (${(input.maxAttempts * input.intervalSeconds) / 60} min)`,
    attempts,
  };
}

/**
 * Google Flow returns `media[N].image.generatedImage.mediaGenerationId`
 * (or `.video.generatedVideo.mediaGenerationId`) — this is the token
 * that later submits reference via referenceVideo_1, startImage, etc.
 * Not the same as the human-facing signed URL that videoUrl/imageUrls
 * extract from normalizeJobBody. Walk the raw shape defensively.
 */
function extractMediaGenerationId(raw: Record<string, unknown>): string | undefined {
  const mediaArr = raw['media'];
  if (!Array.isArray(mediaArr) || mediaArr.length === 0) return undefined;
  for (const m of mediaArr) {
    if (!m || typeof m !== 'object') continue;
    const mm = m as Record<string, unknown>;
    const image = mm['image'] as Record<string, unknown> | undefined;
    const genImg = image?.['generatedImage'] as Record<string, unknown> | undefined;
    const imgId = genImg?.['mediaGenerationId'];
    if (typeof imgId === 'string' && imgId) return imgId;
    const video = mm['video'] as Record<string, unknown> | undefined;
    const genVid = video?.['generatedVideo'] as Record<string, unknown> | undefined;
    const vidId = genVid?.['mediaGenerationId'];
    if (typeof vidId === 'string' && vidId) return vidId;
    // Fallback: top-level mediaGenerationId on the media entry itself.
    const flat = mm['mediaGenerationId'];
    if (typeof flat === 'string' && flat) return flat;
  }
  return undefined;
}

// -----------------------------------------------------------------
// Inngest worker
// -----------------------------------------------------------------

export const generatePolish30OmniVariations = inngest.createFunction(
  {
    id: 'generate-polish30-omni-variations',
    name: 'Polish-30: credit-backed Omni 1.1 Flash variations',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish30-omni-variations.requested' },
  async ({ event, step }) => {
    const data = event.data as Polish30OmniVariationsEventPayload;
    const startedAt = Date.now();
    const jobUserId = assertScalarDefinedForPostgres(
      data.userId,
      'userId',
      'polish30-omni-var:entry',
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
        'polish30 Omni variations requires a concept with vision-analyzed metadata. ' +
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
    const resolutionCandidate = data.resolution ?? metaResolution ?? '720p';
    const resolution: '360p' | '720p' = resolutionCandidate === '360p' ? '360p' : '720p';

    const googleFlowAccount =
      data.googleFlowAccount ?? process.env['USEAPI_NET_DEFAULT_GOOGLE_FLOW_ACCOUNT'];
    if (!googleFlowAccount) {
      const msg =
        'USEAPI_NET_DEFAULT_GOOGLE_FLOW_ACCOUNT env var is unset. An admin needs to register ' +
        'a Google Flow account via useapi.net (see /docs/api-google-flow-v1) and set the ' +
        'env var to that account email.';
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
        polish30_omni_variations_start: {
          resolution,
          variant_count_requested: requestedVariantCount,
          google_flow_account: googleFlowAccount,
          at: nowIso(),
        },
      });
      return safeInngestStepReturn({ ok: true });
    });

    // ---------- C: preflight Claude BYOK ----------
    const keys = await guardedStepRun(step, 'preflight-byok', async () => {
      try {
        const loaded = await loadDecryptedKeys(jobUserId, ['claude']);
        if (!loaded.claude) throw new MissingProviderKeyError('claude');
        return safeInngestStepReturn({ claude: loaded.claude });
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          throw new NonRetriableError(
            `Omni variations needs a Claude BYOK key for the persona+script batch. ` +
              `Missing: ${err.message}. Connect at /settings/connections.`,
          );
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
        throw new NonRetriableError(`polish30 Omni: concept ${conceptId} not found.`);
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
      const userPrompt = composePolish28VariationsUserPrompt(
        rawInput,
        requestedVariantCount,
        MIN_SCRIPT_WORDS,
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
        polish30_omni_variations_batch: {
          variations_returned: parsed.entries.length,
          parse_errors: parsed.errors,
          clips_per_variant: clipsPerVariant,
          source_seconds: source.sourceSeconds,
          at: nowIso(),
        },
      });
      return safeInngestStepReturn({ entries: parsed.entries });
    });

    // ---------- F: render each variation sequentially (not parallel — Omni's
    // chain is inherently serial, and Google Flow rate limits favor
    // one-at-a-time submits) ----------
    const variantResults: RenderOneVariationResult[] = [];
    for (let index = 0; index < variations.entries.length; index++) {
      const entry = variations.entries[index]!;
      try {
        const r = await renderOneVariation({
          step,
          index,
          entry,
          jobId: data.jobId,
          userId: jobUserId,
          googleFlowAccount,
          resolution,
          clipsPerVariant,
        });
        variantResults.push(r);
      } catch (err) {
        console.error(`[polish30-omni-var] variation ${index} failed:`, err);
        variantResults.push({
          index,
          ok: false,
          errorMessage: err instanceof Error ? err.message : String(err),
          clipsSucceeded: 0,
          clipsTotal: clipsPerVariant,
        });
      }
    }

    const successful = variantResults.filter((r) => r.ok);
    const failed = variantResults.filter((r) => !r.ok);

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
        polish30_omni_variations_summary: {
          requested: variations.entries.length,
          succeeded: successful.length,
          failed: failed.length,
          clips_per_variant: clipsPerVariant,
          resolution,
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
  googleFlowAccount: string;
  resolution: '360p' | '720p';
  clipsPerVariant: number;
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
  const { step, index, entry, jobId, userId, googleFlowAccount, resolution } = input;
  const stepSuffix = `v${index}`;

  const clipDialogues = splitScriptIntoClips(entry.script, input.clipsPerVariant);
  if (clipDialogues.length === 0) {
    throw new Error(`variation ${index}: script split produced 0 clips (script too short?)`);
  }

  // 1. Seed still via Nano Banana 2 Lite (0 Flow credits).
  const stillSubmit = await guardedStepRun(step, `still-submit-${stepSuffix}`, async () => {
    const r = await submitNanoBananaImage({
      userId,
      account: googleFlowAccount,
      prompt: composeSeedStillPrompt(entry.persona),
      model: 'nano-banana-2-lite',
      aspectRatio: '9:16',
      n: 1,
      generationJobId: jobId,
    });
    if (!r.ok || !r.jobId) {
      throw new Error(`Nano Banana still submit failed: ${r.errorMessage ?? 'no jobId'}`);
    }
    return safeInngestStepReturn({ jobId: r.jobId });
  });
  const stillPoll = await pollUntilComplete({
    userId,
    jobId: stillSubmit.jobId,
    generationJobId: jobId,
    step,
    stepLabel: `still-${stepSuffix}`,
    maxAttempts: 12,
    intervalSeconds: 5,
  });
  if (!stillPoll.ok || !stillPoll.mediaGenerationId) {
    throw new Error(
      `Nano Banana still poll failed: ${stillPoll.ok ? 'no mediaGenerationId in response' : stillPoll.errorMessage}`,
    );
  }
  const stillMediaId = stillPoll.mediaGenerationId;

  // 2. Seed clip: Omni 1.1 Flash I2V with startFrame = endFrame = still.
  const seedSubmit = await guardedStepRun(step, `seed-submit-${stepSuffix}`, async () => {
    const r = await submitOmniVideo({
      userId,
      account: googleFlowAccount,
      prompt: composeSeedClipPrompt(entry.persona, clipDialogues[0]!),
      durationSeconds: OMNI_CLIP_SECONDS,
      resolution,
      startFrame: { assetId: stillMediaId },
      endFrame: { assetId: stillMediaId },
      generationJobId: jobId,
    });
    if (!r.ok || !r.jobId) {
      throw new Error(`Omni seed submit failed: ${r.errorMessage ?? 'no jobId'}`);
    }
    return safeInngestStepReturn({ jobId: r.jobId });
  });
  const seedPoll = await pollUntilComplete({
    userId,
    jobId: seedSubmit.jobId,
    generationJobId: jobId,
    step,
    stepLabel: `seed-${stepSuffix}`,
    maxAttempts: OMNI_POLL_MAX_ATTEMPTS,
    intervalSeconds: OMNI_POLL_INTERVAL_SECONDS,
  });
  if (!seedPoll.ok || !seedPoll.mediaGenerationId) {
    throw new Error(
      `Omni seed poll failed: ${seedPoll.ok ? 'no mediaGenerationId' : seedPoll.errorMessage}`,
    );
  }
  const clipMediaIds: string[] = [seedPoll.mediaGenerationId];
  let clipsSucceeded = 1;

  // 3. Extend chain — each clip references the PREVIOUS one via
  // referenceVideo_1 so voice + motion + camera + framing inherit.
  for (let clipIndex = 1; clipIndex < clipDialogues.length; clipIndex++) {
    const previousClipMediaId = clipMediaIds[clipMediaIds.length - 1]!;
    const dialogue = clipDialogues[clipIndex]!;
    const extendSubmit = await guardedStepRun(
      step,
      `extend-submit-${stepSuffix}-${clipIndex}`,
      async () => {
        const r = await submitOmniVideo({
          userId,
          account: googleFlowAccount,
          prompt: composeExtendClipPrompt(dialogue),
          resolution,
          referenceVideo: { assetId: previousClipMediaId },
          generationJobId: jobId,
        });
        if (!r.ok || !r.jobId) {
          throw new Error(`Omni extend submit failed: ${r.errorMessage ?? 'no jobId'}`);
        }
        return safeInngestStepReturn({ jobId: r.jobId });
      },
    );
    const extendPoll = await pollUntilComplete({
      userId,
      jobId: extendSubmit.jobId,
      generationJobId: jobId,
      step,
      stepLabel: `extend-${stepSuffix}-${clipIndex}`,
      maxAttempts: OMNI_POLL_MAX_ATTEMPTS,
      intervalSeconds: OMNI_POLL_INTERVAL_SECONDS,
    });
    if (!extendPoll.ok || !extendPoll.mediaGenerationId) {
      // Continue past individual extend failures (same pattern as
      // polish29 Commit 132) so a single dropped clip doesn't kill
      // the whole variation. Concat needs ≥ 2 clips for a usable ad.
      console.warn(
        `[polish30-omni-var] extend ${clipIndex} failed for variation ${index}: ${
          extendPoll.ok ? 'no mediaGenerationId' : extendPoll.errorMessage
        }`,
      );
      break;
    }
    clipMediaIds.push(extendPoll.mediaGenerationId);
    clipsSucceeded++;
  }

  if (clipsSucceeded < MIN_CLIPS_PER_VARIANT) {
    return {
      index,
      ok: false,
      errorMessage: `Only ${clipsSucceeded}/${clipDialogues.length} clips rendered — need at least ${MIN_CLIPS_PER_VARIANT}`,
      clipsSucceeded,
      clipsTotal: clipDialogues.length,
    };
  }

  // 4. Concatenate via Google Flow /videos/concatenate.
  // Trim the pin-frame quiet beats at the joins.
  const concatSubmit = await guardedStepRun(step, `concat-submit-${stepSuffix}`, async () => {
    const segments = clipMediaIds.map((mediaId, i) => ({
      videoRef: mediaId,
      ...(i < clipMediaIds.length - 1 ? { trimEnd: CONCAT_TRIM_END_SECONDS } : {}),
      ...(i > 0 ? { trimStart: CONCAT_TRIM_START_SECONDS } : {}),
    }));
    const r = await submitGoogleFlowConcat({
      userId,
      account: googleFlowAccount,
      segments,
      generationJobId: jobId,
    });
    if (!r.ok || !r.jobId) {
      throw new Error(`Google Flow concat submit failed: ${r.errorMessage ?? 'no jobId'}`);
    }
    return safeInngestStepReturn({ jobId: r.jobId });
  });
  const concatPoll = await pollUntilComplete({
    userId,
    jobId: concatSubmit.jobId,
    generationJobId: jobId,
    step,
    stepLabel: `concat-${stepSuffix}`,
    maxAttempts: 24,
    intervalSeconds: 5,
  });
  if (!concatPoll.ok || !concatPoll.videoUrl) {
    throw new Error(
      `Google Flow concat poll failed: ${
        concatPoll.ok ? 'no videoUrl in response' : concatPoll.errorMessage
      }`,
    );
  }
  const concatUrl = concatPoll.videoUrl;

  // 5. Store composite in Supabase.
  const stored = await guardedStepRun(step, `store-composite-${stepSuffix}`, async () => {
    try {
      const r = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: concatUrl,
        filename: `polish30-omni-var-${jobId}-${index}.mp4`,
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

  // 6. Persist creative row.
  await guardedStepRun(step, `persist-${stepSuffix}`, async () => {
    const db = getDb();
    await db.insert(schema.generatedCreatives).values({
      userId,
      generationJobId: jobId,
      fileUrl: finalUrl,
      aspectRatio: '9:16',
      status: 'ready',
      format: 'polish30_omni_variations',
      hookVariantIndex: index,
      bodyVariantIndex: index,
      ctaVariantIndex: index,
      headline: (entry.persona.age_range + ' ' + entry.persona.gender).slice(0, 200),
      primaryText: entry.script.slice(0, 500),
      generationMetadata: {
        polish30_omni: true,
        variant_index: index,
        clips_total: clipDialogues.length,
        clips_succeeded: clipsSucceeded,
        clip_media_ids: clipMediaIds,
        still_media_id: stillMediaId,
        composite_source_url: concatUrl,
        composite_supabase_ok: stored.kind === 'ok',
        composite_supabase_error: stored.kind === 'err' ? stored.errorMessage : null,
        persona: entry.persona,
        resolution,
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
