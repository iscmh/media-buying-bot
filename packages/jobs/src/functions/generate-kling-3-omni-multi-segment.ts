import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  checkKlingOmni,
  checkReplicateConcat,
  estimateKlingOmniSegmentCostUsd,
  getUniversalUgcMasterPrompt,
  isVideoConcatEnabled,
  submitKlingOmni,
  submitReplicateConcat,
  type KlingOmniMode,
  type KlingOmniShot,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedImage } from '../lib/storage';
import {
  buildImagePromptForClip,
  parseProductionManual,
  stripCharacterSheetPattern,
} from './generate-kling-multi-clip-variants';

/**
 * Polish-10: Kling 3.0 Omni multi-segment pipeline.
 *
 * Renders a 30-second UGC ad as N (typically 2) Kling Omni segments,
 * each 15s, sharing one Nano Banana reference frame so character
 * identity stays consistent across segments. Each segment uses Omni's
 * native multi-shot mode (multi_prompt) to chain up to 6 connected
 * shots internally — internal continuity is native, not stitched. The
 * single boundary between segments is crossfaded via the existing
 * Replicate ffmpeg-concat helper.
 *
 * Cost rough-cut (pro mode + audio):
 *   2 × 15s × $0.28/sec  = $8.40 (Kling Omni)
 *   + ~$0.10 manual + reference + stitch
 *   ≈ $8.50/variant
 *
 * Master prompt + Forge fixture remain untouched (prompt fidelity
 * rule). Parser + buildImagePromptForClip + stripCharacterSheetPattern
 * are imported verbatim from the legacy multi-clip worker — same
 * Section A/C extraction semantics.
 */

const SEGMENT_DURATION_SECONDS = 15;
const MAX_SHOTS_PER_SEGMENT = 6;
const POLL_INTERVAL_SECONDS = 15;
const REPLICATE_POLL_TIMEOUT_MS = Number(process.env.REPLICATE_POLL_TIMEOUT_MS) || 600_000;
const POLL_MAX_ATTEMPTS = Math.ceil(REPLICATE_POLL_TIMEOUT_MS / 1000 / POLL_INTERVAL_SECONDS);
const KLING_OMNI_MODE: KlingOmniMode =
  (process.env.REPLICATE_KLING_OMNI_MODE as KlingOmniMode | undefined) ?? 'pro';

export const generateKling3OmniMultiSegment = inngest.createFunction(
  {
    id: 'generate-kling-3-omni-multi-segment',
    name: 'Generate Kling 3.0 Omni multi-segment variants',
    retries: 1,
  },
  { event: 'generation/kling-3-omni-multi-segment.requested' },
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

    if (mode === 'mock') {
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-composite', async () => {
        const db = getDb();
        await db.insert(schema.generatedCreatives).values({
          userId,
          generationJobId: jobId,
          fileUrl: 'https://samplelib.com/lib/preview/mp4/sample-15s.mp4',
          aspectRatio: '9:16',
          status: 'ready_for_review',
          format: 'kling_3_omni_multi_segment',
          isClipPart: false,
          generationMetadata: { mock: true, segments: 2 },
        });
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount,
        actualCostUsd: 0,
        provider: 'kling',
        path: 'kling-3-omni-multi-segment',
      });
      return { jobId, mode, generated: variantCount };
    }

    // live: ask Claude for the production manual
    const manualResult = await step.run('claude-production-manual', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message, costUsd: 0 };
        throw err;
      }
      const systemPrompt = getUniversalUgcMasterPrompt();
      const userMessage = JSON.stringify({
        analysis: job?.metadata ?? {},
        variant_count: variantCount,
        target_duration_seconds: 30,
        segment_duration_seconds: SEGMENT_DURATION_SECONDS,
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
        console.log(`[omni-manual] Claude call failed: ${claude.errorMessage ?? 'unknown'}`);
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude manual generation failed',
          costUsd: claude.costUsd,
        };
      }
      console.log(
        `[omni-manual] Claude returned ${(claude.text ?? '').length} chars; first 1000: ${(
          claude.text ?? ''
        ).slice(0, 1000)}`,
      );
      const parsed = parseProductionManual(claude.json ?? claude.text);
      if (!parsed.ok) {
        console.log(`[omni-manual] parse failed: ${parsed.error}`);
        return { ok: false as const, error: parsed.error, costUsd: claude.costUsd };
      }
      return { ok: true as const, manual: parsed.manual, costUsd: claude.costUsd };
    });

    if (!manualResult.ok) {
      await markJobFailed(jobId, userId, manualResult.error, manualResult.costUsd);
      return { jobId, mode, generated: 0 };
    }

    const manual = manualResult.manual;
    let totalCost = manualResult.costUsd;

    // 1. Generate shared character reference frame via Nano Banana
    const referenceResult = await step.run('nano-banana-reference', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['gemini']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message, costUsd: 0 };
        throw err;
      }
      const firstClip = manual.clips[0];
      if (!firstClip) {
        return { ok: false as const, error: 'Manual has 0 clips', costUsd: 0 };
      }
      const prompt = buildImagePromptForClip(manual, firstClip);
      const image = await callGeminiImage({
        userId,
        apiKey: keys.gemini!,
        prompt,
        generationJobId: jobId,
      });
      if (!image.ok || !image.imageBase64 || !image.imageMimeType) {
        return {
          ok: false as const,
          error: image.errorMessage ?? 'Nano Banana returned no image',
          costUsd: image.costUsd,
        };
      }
      try {
        const upload = await uploadGeneratedImage({
          userId,
          jobId,
          variantIndex: 0,
          imageBase64: image.imageBase64,
          mimeType: image.imageMimeType,
          filenamePrefix: 'omni-ref-',
        });
        return { ok: true as const, publicUrl: upload.publicUrl, costUsd: image.costUsd };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false as const,
          error: `Reference frame upload failed: ${msg}`,
          costUsd: image.costUsd,
        };
      }
    });
    if (!referenceResult.ok) {
      await markJobFailed(
        jobId,
        userId,
        referenceResult.error,
        totalCost + referenceResult.costUsd,
      );
      return { jobId, mode, generated: 0 };
    }
    totalCost += referenceResult.costUsd;
    const referenceImageUrl = referenceResult.publicUrl;

    // 2. Split clips into segments
    const segmentCount = computeSegmentCount(manual.clips.length);
    const segmentClipGroups = splitClipsIntoSegments(manual.clips, segmentCount);

    // 3. Generate each segment
    const segmentResults: { segmentIndex: number; videoUrl: string }[] = [];
    for (let segmentIndex = 0; segmentIndex < segmentClipGroups.length; segmentIndex++) {
      const clipGroup = segmentClipGroups[segmentIndex]!;
      const segmentResult = await step.run(`omni-segment-${segmentIndex}`, async () => {
        let keys;
        try {
          keys = await loadDecryptedKeys(userId, ['kling']);
        } catch (err) {
          if (err instanceof MissingProviderKeyError)
            return { ok: false as const, error: err.message, costUsd: 0 };
          throw err;
        }
        const { outerPrompt, multiPrompt } = buildSegmentPrompt(
          manual,
          clipGroup,
          SEGMENT_DURATION_SECONDS,
        );
        return submitKlingOmni({
          userId,
          apiKey: keys.kling!,
          prompt: outerPrompt,
          multiPrompt,
          referenceImageUrls: [referenceImageUrl],
          durationSeconds: SEGMENT_DURATION_SECONDS,
          aspectRatio: '9:16',
          mode: KLING_OMNI_MODE,
          generationJobId: jobId,
        });
      });
      if (!segmentResult.ok || !('predictionId' in segmentResult) || !segmentResult.predictionId) {
        const err =
          'errorMessage' in segmentResult
            ? segmentResult.errorMessage
            : 'error' in segmentResult
              ? segmentResult.error
              : 'Omni submit failed';
        console.log(`[omni-segment-${segmentIndex}] submit failed: ${err}`);
        await markJobFailed(jobId, userId, err ?? 'submit failed', totalCost);
        return { jobId, mode, generated: 0 };
      }
      // Poll
      let segmentVideoUrl: string | undefined;
      let pollError: string | undefined;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await step.sleep(`omni-poll-${segmentIndex}-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
        const tick = await step.run(`omni-check-${segmentIndex}-${attempt}`, async () => {
          const keys = await loadDecryptedKeys(userId, ['kling']);
          return checkKlingOmni({
            userId,
            apiKey: keys.kling!,
            predictionId: segmentResult.predictionId!,
            durationSeconds: SEGMENT_DURATION_SECONDS,
            mode: KLING_OMNI_MODE,
            generationJobId: jobId,
          });
        });
        if (tick.status === 'completed') {
          segmentVideoUrl = tick.videoUrl;
          totalCost += tick.costUsd;
          break;
        }
        if (tick.status === 'failed') {
          pollError = tick.errorMessage ?? 'Omni segment failed';
          break;
        }
      }
      if (!segmentVideoUrl) {
        const err =
          pollError ?? `Omni segment ${segmentIndex} timed out after ${POLL_MAX_ATTEMPTS} polls`;
        console.log(`[omni-segment-${segmentIndex}] ${err}`);
        await markJobFailed(jobId, userId, err, totalCost);
        return { jobId, mode, generated: 0 };
      }
      segmentResults.push({ segmentIndex, videoUrl: segmentVideoUrl });
      console.log(`[omni-segment-${segmentIndex}] ready: ${segmentVideoUrl}`);
    }

    // 4. If only 1 segment, write it as the composite.
    if (segmentResults.length === 1) {
      const only = segmentResults[0]!;
      await step.run('write-composite-single', async () => {
        const db = getDb();
        await db.insert(schema.generatedCreatives).values({
          userId,
          generationJobId: jobId,
          fileUrl: only.videoUrl,
          aspectRatio: '9:16',
          status: 'ready_for_review',
          format: 'kling_3_omni_multi_segment',
          isClipPart: false,
          generationMetadata: {
            segments: 1,
            character_prompt: manual.characterPrompt,
            set_prompt: manual.setPrompt,
            reference_image_url: referenceImageUrl,
            mode: KLING_OMNI_MODE,
          },
        });
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount: 1,
        actualCostUsd: totalCost,
        provider: 'kling',
        path: 'kling-3-omni-multi-segment',
      });
      return { jobId, mode, generated: 1, totalCost };
    }

    // 5. 2+ segments → stitch via existing replicate-concat helper.
    const orderedUrls = segmentResults
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map((s) => s.videoUrl);

    let stitchedUrl: string | undefined;
    if (isVideoConcatEnabled()) {
      const stitchSubmit = await step.run('omni-stitch-submit', async () => {
        let keys;
        try {
          keys = await loadDecryptedKeys(userId, ['kling']);
        } catch (err) {
          if (err instanceof MissingProviderKeyError)
            return { ok: false as const, error: err.message };
          throw err;
        }
        return submitReplicateConcat({
          userId,
          apiKey: keys.kling!,
          videoUrls: orderedUrls,
          generationJobId: jobId,
        });
      });
      if (stitchSubmit.ok && 'predictionId' in stitchSubmit && stitchSubmit.predictionId) {
        const predictionId = stitchSubmit.predictionId;
        for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
          await step.sleep(`omni-stitch-poll-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
          const tick = await step.run(`omni-stitch-check-${attempt}`, async () => {
            const keys = await loadDecryptedKeys(userId, ['kling']);
            return checkReplicateConcat({
              userId,
              apiKey: keys.kling!,
              predictionId,
              generationJobId: jobId,
            });
          });
          if (tick.status === 'completed') {
            stitchedUrl = tick.videoUrl;
            totalCost += tick.costUsd;
            break;
          }
          if (tick.status === 'failed') {
            console.log(`[omni-stitch] failed: ${tick.errorMessage ?? 'unknown'}`);
            break;
          }
        }
      } else {
        const err =
          'errorMessage' in stitchSubmit
            ? stitchSubmit.errorMessage
            : 'error' in stitchSubmit
              ? stitchSubmit.error
              : 'submit failed';
        console.log(`[omni-stitch] submit failed: ${err}`);
      }
    } else {
      console.log('[omni-stitch] REPLICATE_VIDEO_CONCAT_MODEL_ID not set; using segment 0');
    }

    const compositeUrl = stitchedUrl ?? orderedUrls[0]!;
    await step.run('write-composite', async () => {
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        fileUrl: compositeUrl,
        aspectRatio: '9:16',
        status: 'ready_for_review',
        format: 'kling_3_omni_multi_segment',
        isClipPart: false,
        generationMetadata: {
          segments: segmentResults.length,
          source_segment_urls: orderedUrls,
          reference_image_url: referenceImageUrl,
          stitched: !!stitchedUrl,
          character_prompt: manual.characterPrompt,
          set_prompt: manual.setPrompt,
          mode: KLING_OMNI_MODE,
        },
      });
    });
    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: 1,
      actualCostUsd: totalCost,
      provider: 'kling',
      path: 'kling-3-omni-multi-segment',
    });
    return { jobId, mode, generated: 1, totalCost };
  },
);

// =========================================================================
// Pure helpers — exported for unit tests
// =========================================================================

/**
 * Determine how many Omni segments to render based on parsed clip
 * count. Each clip is roughly 6s of dialogue; each Omni segment is
 * 15s. Default to 2 segments for full UGC ads (~30s); cap at 2 to
 * keep cost predictable. Single-clip manuals collapse to 1 segment.
 */
export function computeSegmentCount(clipCount: number): number {
  if (clipCount <= 0) return 0;
  if (clipCount <= 2) return 1;
  return 2;
}

/**
 * Balanced sequential split — first N/2 clips into segment 0, second
 * half into segment 1. Empty groups are dropped so a small clipCount
 * doesn't produce empty trailing segments.
 */
export function splitClipsIntoSegments<T>(clips: T[], segmentCount: number): T[][] {
  if (segmentCount <= 0 || clips.length === 0) return [];
  const perSegment = Math.ceil(clips.length / segmentCount);
  const out: T[][] = [];
  for (let i = 0; i < segmentCount; i++) {
    const slice = clips.slice(i * perSegment, (i + 1) * perSegment);
    if (slice.length > 0) out.push(slice);
  }
  return out;
}

interface ClipLike {
  videoPrompt: string;
  dialogue?: string;
}

/**
 * Build the Omni segment prompt + multi_prompt array from a clip
 * group. The outer prompt is an overall scene description; per-shot
 * prompts in multi_prompt reference `<<<image_1>>>` so the model
 * grounds each shot's character on the shared reference frame.
 *
 * Per-shot duration is balanced so the sum equals SEGMENT_DURATION_
 * SECONDS — Replicate's schema requires this. Truncates to
 * MAX_SHOTS_PER_SEGMENT (6) per the model's documented limit.
 */
export function buildSegmentPrompt<C extends ClipLike>(
  manual: { characterPrompt: string; setPrompt: string },
  clipGroup: C[],
  segmentDurationSeconds: number,
): { outerPrompt: string; multiPrompt: KlingOmniShot[] } {
  const shotCount = Math.min(clipGroup.length, MAX_SHOTS_PER_SEGMENT);
  const trimmed = clipGroup.slice(0, shotCount);
  const character = stripCharacterSheetPattern(manual.characterPrompt);

  // Balance per-shot durations; distribute remainder across the
  // first `remainder` shots so the sum lands exactly.
  const baseSecs = Math.floor(segmentDurationSeconds / shotCount);
  const remainder = segmentDurationSeconds - baseSecs * shotCount;
  const durations: number[] = Array.from({ length: shotCount }, (_, i) =>
    i < remainder ? baseSecs + 1 : baseSecs,
  );

  const multiPrompt: KlingOmniShot[] = trimmed.map((clip, i) => ({
    prompt: buildShotPrompt(clip),
    duration: durations[i]!,
  }));

  const dialogueList = trimmed
    .map((c) => c.dialogue?.trim())
    .filter((d): d is string => Boolean(d && d.length > 0));
  const dialogueLine =
    dialogueList.length > 0
      ? `Dialogue (one continuous monologue, spoken naturally and quickly): ${dialogueList
          .map((d) => `"${d}"`)
          .join(' ')}`
      : '';

  const outerPrompt = [
    `<<<image_1>>> Single-character UGC selfie ad. Character: ${character}`,
    `Scene/Set: ${manual.setPrompt}`,
    `This is a single ${segmentDurationSeconds}-second video with ${shotCount} connected shot${
      shotCount === 1 ? '' : 's'
    }. Shot transitions are seamless — no hard cuts, continuous character identity, motion, lighting, and audio.`,
    dialogueLine,
    'AMATEUR SMARTPHONE SELFIE captured on an iPhone front camera in handheld vertical orientation. NOT cinematic, NOT studio. Natural ambient indoor or daylight. Hyper-realistic skin with pores and natural imperfections.',
    'Speech delivery: NATURAL CONVERSATIONAL pace, like a real person talking to a friend. NO dramatic pauses, NO dead air at start or end.',
  ]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n');

  return { outerPrompt, multiPrompt };
}

function buildShotPrompt<C extends ClipLike>(clip: C): string {
  const body = clip.videoPrompt.trim();
  const dialogueLine =
    clip.dialogue && clip.dialogue.trim().length > 0
      ? ` [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "${clip.dialogue.trim()}"`
      : '';
  // Always prefix with the reference image token so the shot
  // grounds the character on the shared frame.
  const withRef = /<<<image_\d+>>>/.test(body) ? body : `<<<image_1>>> ${body}`;
  return `${withRef}${dialogueLine}`;
}

void estimateKlingOmniSegmentCostUsd;
