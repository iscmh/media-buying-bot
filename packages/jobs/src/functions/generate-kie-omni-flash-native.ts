import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  getUniversalUgcMasterPrompt,
  pollKieOmniTask,
  submitKieOmniVideo,
  type KieOmniDuration,
  type KieOmniResolution,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { KIE_OMNI_FLASH_HARD_DIRECTIVE } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';
import {
  buildImagePromptForClip,
  parseProductionManual,
  stripAudioEraArtifacts,
  stripCharacterSheetPattern,
  stripTextCaptionsBroll,
} from './generate-kling-multi-clip-variants';

/**
 * Polish-12: kie.ai Gemini Omni Flash native pipeline.
 *
 * One API call replaces the Polish-11 multi-clip + ElevenLabs TTS +
 * lipsync stack. Omni Flash generates 10s of video with native
 * synchronized audio + lipsync from one prompt + one reference image.
 *
 * Flow:
 *   1. Load job + decrypted keys (claude, gemini, kie_ai).
 *   2. Claude → production manual via the universal-ugc master prompt.
 *      Reuses the Polish-9.10 [USE IMAGE X]-anchored parser.
 *   3. Nano Banana reference frame from the first clip's image prompt.
 *      Uploaded to Supabase Storage so kie.ai's fetcher can resolve
 *      it via public URL.
 *   4. Build the Omni Flash prompt: KIE_OMNI_FLASH_HARD_DIRECTIVE +
 *      scrubbed character + scene + concatenated dialogue + pacing.
 *   5. submitKieOmniVideo with the prompt + reference URL.
 *   6. Poll every 10s (after a 15s warmup) until state='success' or
 *      'fail' or the 5-min ceiling expires.
 *   7. Re-upload the kie.ai CDN mp4 to Supabase for a durable URL.
 *   8. Write one generated_creatives row (is_clip_part=false,
 *      format='kie_omni_flash_native').
 *
 * Per-variant cost ≈ $0.95 (Omni $0.90 + Nano Banana $0.05).
 */

const KIE_OMNI_DURATION: KieOmniDuration = '10';
const KIE_OMNI_RESOLUTION: KieOmniResolution = '1080p';
// Polish-12: 15s warmup before first poll, then 10s between checks.
// 30 polls × 10s = 300s = 5min ceiling per the spec.
const POLL_WARMUP_SECONDS = 15;
const POLL_INTERVAL_SECONDS = 10;
const POLL_MAX_ATTEMPTS = 30;

export const generateKieOmniFlashNative = inngest.createFunction(
  {
    id: 'generate-kie-omni-flash-native',
    name: 'Generate Gemini Omni Flash native UGC ad',
    retries: 1,
  },
  { event: 'generation/kie-omni-flash-native.requested' },
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
    if (!job) {
      await markJobFailed(jobId, userId, 'job row not found', 0);
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
          fileUrl: 'https://samplelib.com/lib/preview/mp4/sample-10s.mp4',
          aspectRatio: '9:16',
          status: 'ready_for_review',
          format: 'kie_omni_flash_native',
          isClipPart: false,
          generationMetadata: { mock: true },
        });
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount: 1,
        actualCostUsd: 0,
        provider: 'kling',
        path: 'kie-omni-flash-native',
      });
      return { jobId, mode, generated: 1 };
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
        analysis: job.metadata ?? {},
        variant_count: 1,
        target_duration_seconds: Number(KIE_OMNI_DURATION),
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
        console.log(`[kie-omni-manual] Claude call failed: ${claude.errorMessage ?? 'unknown'}`);
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude manual generation failed',
          costUsd: claude.costUsd,
        };
      }
      console.log(
        `[kie-omni-manual] Claude returned ${(claude.text ?? '').length} chars; first 1000: ${(
          claude.text ?? ''
        ).slice(0, 1000)}`,
      );
      const parsed = parseProductionManual(claude.json ?? claude.text);
      if (!parsed.ok) {
        console.log(`[kie-omni-manual] parse failed: ${parsed.error}`);
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
          filenamePrefix: 'kie-omni-ref-',
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

    // 2. Build the unified Omni Flash prompt
    const promptText = buildOmniFlashPrompt(manual, Number(KIE_OMNI_DURATION));

    // 3. Submit to kie.ai
    const submitResult = await step.run('kie-omni-submit', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['kie_ai']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message };
        throw err;
      }
      return submitKieOmniVideo({
        userId,
        apiKey: keys.kie_ai!,
        prompt: promptText,
        imageUrls: [referenceImageUrl],
        durationSeconds: KIE_OMNI_DURATION,
        aspectRatio: '9:16',
        resolution: KIE_OMNI_RESOLUTION,
        generationJobId: jobId,
      });
    });
    if (!submitResult.ok || !('taskId' in submitResult) || !submitResult.taskId) {
      const err =
        'errorMessage' in submitResult
          ? submitResult.errorMessage
          : 'error' in submitResult
            ? submitResult.error
            : 'kie.ai submit failed';
      console.log(`[kie-omni] submit failed: ${err}`);
      await markJobFailed(jobId, userId, err ?? 'submit failed', totalCost);
      return { jobId, mode, generated: 0 };
    }
    const taskId = submitResult.taskId;

    // 4. Poll
    await step.sleep('kie-omni-warmup', `${POLL_WARMUP_SECONDS}s`);
    let outputUrl: string | undefined;
    let pollError: string | undefined;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const tick = await step.run(`kie-omni-check-${attempt}`, async () => {
        const keys = await loadDecryptedKeys(userId, ['kie_ai']);
        return pollKieOmniTask({
          userId,
          apiKey: keys.kie_ai!,
          taskId,
          generationJobId: jobId,
        });
      });
      if (!tick.ok) {
        pollError = tick.errorMessage ?? 'kie.ai poll failed';
        break;
      }
      if (tick.state === 'success') {
        outputUrl = tick.outputUrl;
        break;
      }
      if (tick.state === 'fail') {
        pollError =
          tick.failMsg ?? `kie.ai task failed${tick.failCode ? ` (${tick.failCode})` : ''}`;
        break;
      }
      await step.sleep(`kie-omni-poll-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
    }

    if (!outputUrl) {
      const err =
        pollError ??
        `Omni Flash generation timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS}s`;
      console.log(`[kie-omni] ${err}`);
      await markJobFailed(jobId, userId, err, totalCost);
      return { jobId, mode, generated: 0 };
    }

    // 5. Re-upload to Supabase for a durable URL
    const uploadResult = await step.run('kie-omni-upload', async () => {
      try {
        const upload = await uploadGeneratedVideoFromUrl({
          userId,
          jobId,
          remoteUrl: outputUrl!,
          filename: 'omni-output',
        });
        return { ok: true as const, publicUrl: upload.publicUrl, sizeBytes: upload.sizeBytes };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: msg };
      }
    });
    if (!uploadResult.ok) {
      // Fall back to kie.ai's CDN URL — non-fatal, still write the row.
      console.log(
        `[kie-omni] re-upload failed, using kie.ai CDN URL directly: ${uploadResult.error}`,
      );
    }
    const finalUrl = uploadResult.ok ? uploadResult.publicUrl : outputUrl;

    // 6. Persist the deliverable
    totalCost += 0.9; // Polish-12: Omni Flash cost per the kie-omni client.
    await step.run('write-final', async () => {
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        fileUrl: finalUrl,
        aspectRatio: '9:16',
        status: 'ready_for_review',
        format: 'kie_omni_flash_native',
        isClipPart: false,
        generationMetadata: {
          kie_task_id: taskId,
          kie_source_url: outputUrl,
          reupload_ok: uploadResult.ok,
          reference_image_url: referenceImageUrl,
          character_prompt: manual.characterPrompt,
          set_prompt: manual.setPrompt,
          duration_seconds: Number(KIE_OMNI_DURATION),
          resolution: KIE_OMNI_RESOLUTION,
        },
      });
    });
    console.log(`[kie-omni] final written: ${finalUrl}`);

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: 1,
      actualCostUsd: totalCost,
      provider: 'kling',
      path: 'kie-omni-flash-native',
    });
    return { jobId, mode, generated: 1, totalCost };
  },
);

// =========================================================================
// Pure helpers — exported for unit tests
// =========================================================================

interface OmniManualLike {
  characterPrompt: string;
  setPrompt: string;
  clips: Array<{ videoPrompt: string; dialogue?: string }>;
}

/**
 * Build the unified Omni Flash prompt. Omni has no negative_prompt, so
 * everything goes positive: KIE_OMNI_FLASH_HARD_DIRECTIVE first
 * (caption/b-roll/studio-lighting suppressors), then scrubbed character
 * + scene, then the full dialogue concatenated as one continuous
 * monologue with explicit pacing.
 *
 * Inputs run through the same three filters as Polish-11.2's image
 * prompt: stripCharacterSheetPattern + stripTextCaptionsBroll +
 * stripAudioEraArtifacts. Quoted dialogue preserved in the monologue
 * block so Omni's native lipsync has the exact words to sync to.
 */
export function buildOmniFlashPrompt(manual: OmniManualLike, durationSeconds: number): string {
  const character = stripTextCaptionsBroll(stripCharacterSheetPattern(manual.characterPrompt));
  const scene = stripTextCaptionsBroll(manual.setPrompt);
  const monologue = buildContinuousMonologue(manual.clips);

  const parts = [
    KIE_OMNI_FLASH_HARD_DIRECTIVE,
    '',
    `CHARACTER: ${character}`,
    '',
    `SCENE / SET: ${scene}`,
    '',
    monologue
      ? `DIALOGUE (the character delivers this as one continuous spoken monologue): ${monologue}`
      : 'No dialogue — natural ambient sound only.',
    '',
    `PACING: Deliver the full dialogue at natural conversational pace (~150 words per minute). The complete monologue must fit in the ${durationSeconds}-second duration with no dead air at start or end and no long dramatic pauses.`,
  ];
  return parts.join('\n').trim();
}

/**
 * Concatenate every clip's dialogue into one continuous monologue
 * preserving the quotes so Omni's lipsync has explicit phrase
 * boundaries to align to. Dedupes consecutive identical lines.
 * Strips audio-era brackets / quotes from the source body when
 * clip.dialogue isn't pre-populated.
 */
export function buildContinuousMonologue(clips: OmniManualLike['clips']): string {
  const lines: string[] = [];
  let prev = '';
  for (const clip of clips) {
    const line = pickDialogue(clip).trim();
    if (!line || line === prev) continue;
    lines.push(`"${line}"`);
    prev = line;
  }
  return lines.join(' ').trim();
}

function pickDialogue(clip: { videoPrompt: string; dialogue?: string }): string {
  if (clip.dialogue && clip.dialogue.trim()) return clip.dialogue.trim();
  // Bracket form first — stripAudioEraArtifacts would eat the quoted
  // payload, leaving nothing for the quote-match fallback below.
  const bracket = clip.videoPrompt.match(/\[GENERATE\s+NATIVE\s+AUDIO[^\]]*\]\s*:\s*"([^"]+)"/i);
  if (bracket && bracket[1]) return bracket[1].trim();
  // Any other quoted run (≥ 4 chars), but only after scrubbing
  // remaining bracket noise.
  const scrubbed = stripAudioEraArtifacts(clip.videoPrompt);
  const m = scrubbed.match(/"([^"]{4,})"/);
  if (m && m[1]) return m[1].trim();
  return '';
}
