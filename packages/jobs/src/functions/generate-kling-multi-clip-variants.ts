import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  checkAudioTrim,
  checkLipsync,
  checkReplicateConcat,
  getDefaultElevenLabsVoiceId,
  getUniversalUgcMasterPrompt,
  isAudioTrimEnabled,
  isLipsyncEnabled,
  isVideoConcatEnabled,
  submitAudioTrim,
  submitElevenLabsTts,
  submitKlingVideo,
  submitLipsync,
  submitReplicateConcat,
  checkKlingPrediction,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import {
  downloadGeneratedImageAsBase64,
  uploadGeneratedAudio,
  uploadGeneratedImage,
} from '../lib/storage';

/**
 * Polish-6 item 4: Kling 3.0 multi-clip native lipsync pipeline.
 *
 * Uses the UNIVERSAL_UGC_MASTER_PROMPT (loaded verbatim from .md) as
 * Claude's system prompt. Claude produces a Complete Video Production
 * Manual with character_prompt, set_prompt, and ~16 clips (6s each).
 * Each clip gets a first-frame image gen (deferred to Kling image-to-
 * video with text prompt for now) + a Kling video generation call.
 *
 * PROMPT FIDELITY: the master prompt is loaded via getUniversalUgc-
 * MasterPrompt() from the .md file, never modified or inlined.
 *
 * Cost: ~$4.80 per variant (16 clips × $0.30 Kling each). Surfaced
 * in the cost estimator so the user sees it before submitting.
 */

const CLIPS_PER_VARIANT = 16;
const CLIP_DURATION_SECONDS = 6;
const CONCURRENCY = 3;
// Polish-9.6: poll ceiling = POLL_INTERVAL × POLL_MAX_ATTEMPTS. Default
// 15s × 40 = 600s = 10 min per clip (matches REPLICATE_POLL_TIMEOUT_MS
// spec ceiling). REPLICATE_POLL_TIMEOUT_MS env overrides the ceiling
// without touching the interval — useful when Replicate gets slow.
const REPLICATE_POLL_TIMEOUT_MS = Number(process.env.REPLICATE_POLL_TIMEOUT_MS) || 600_000;
const POLL_INTERVAL_SECONDS = 15;
const POLL_MAX_ATTEMPTS = Math.ceil(REPLICATE_POLL_TIMEOUT_MS / 1000 / POLL_INTERVAL_SECONDS);
const MOCK_VIDEO_URL = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

export const generateKlingMultiClipVariants = inngest.createFunction(
  {
    id: 'generate-kling-multi-clip-variants',
    name: 'Generate Kling 3.0 multi-clip variants',
    retries: 1,
  },
  { event: 'generation/kling-multi-clip.requested' },
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

    // mock path
    if (mode === 'mock') {
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount * CLIPS_PER_VARIANT }, (_, i) => ({
          userId,
          generationJobId: jobId,
          fileUrl: MOCK_VIDEO_URL,
          aspectRatio: '9:16' as const,
          status: 'ready_for_review' as const,
          format: 'kling_3_multi_clip',
          clipIndex: i % CLIPS_PER_VARIANT,
          isClipPart: true,
          generationMetadata: { mock: true, clip_index: i % CLIPS_PER_VARIANT },
        }));
        await db.insert(schema.generatedCreatives).values(rows);
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount,
        actualCostUsd: 0,
        provider: 'kling',
        path: 'kling-multi-clip',
      });
      return { jobId, mode, generated: variantCount };
    }

    // live: ask Claude to build the production manual
    const manualResult = await step.run('claude-production-manual', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          return { ok: false as const, error: err.message, costUsd: 0 };
        }
        throw err;
      }

      const systemPrompt = getUniversalUgcMasterPrompt();
      const analysis = job?.metadata ?? {};
      const userMessage = JSON.stringify({
        analysis,
        variant_count: variantCount,
        clips_per_variant: CLIPS_PER_VARIANT,
        clip_duration_seconds: CLIP_DURATION_SECONDS,
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
        console.log(`[kling-manual] Claude call failed: ${claude.errorMessage ?? 'unknown'}`);
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude manual generation failed',
          costUsd: claude.costUsd,
        };
      }
      // Polish-9.7: capture raw output for diagnostics. The parser used
      // to silently fall back to a single bad clip on non-JSON; now it
      // hard-fails with a clear error and we log the first 1000 chars
      // so the Inngest dashboard shows what Claude actually returned.
      console.log(
        `[kling-manual] Claude returned ${(claude.text ?? '').length} chars; ` +
          `first 1000: ${(claude.text ?? '').slice(0, 1000)}`,
      );
      const parsed = parseProductionManual(claude.json ?? claude.text);
      if (!parsed.ok) {
        console.log(`[kling-manual] parse failed: ${parsed.error}`);
        return { ok: false as const, error: parsed.error, costUsd: claude.costUsd };
      }
      const expectedTotal = variantCount * CLIPS_PER_VARIANT;
      if (parsed.manual.clips.length !== expectedTotal) {
        console.log(
          `[kling-manual] parsed ${parsed.manual.clips.length} clips (expected ${expectedTotal}); proceeding with what we have`,
        );
      }
      return { ok: true as const, manual: parsed.manual, costUsd: claude.costUsd };
    });

    if (!manualResult.ok) {
      await markJobFailed(jobId, userId, manualResult.error, manualResult.costUsd);
      return { jobId, mode, generated: 0 };
    }

    const { manual } = manualResult;
    let totalCost = manualResult.costUsd;
    let successCount = 0;
    const clipVideoUrls: { clipIndex: number; videoUrl: string }[] = [];

    /**
     * Polish-9.12: process one clip end-to-end (nano-banana → kling
     * submit → poll → persist). When `useReferenceFromClip0` is true,
     * the nano-banana step pulls clip 0's frame from storage and
     * passes it to Gemini as a reference image so the character +
     * scene anchor stays consistent across all clips.
     */
    const processClip = async (
      clipIndex: number,
      clip: (typeof manual.clips)[number],
      useReferenceFromClip0: boolean,
    ): Promise<{
      clipIndex: number;
      ok: boolean;
      costUsd: number;
      error?: string;
      videoUrl?: string;
    }> => {
      const frameResult = await step.run(`nano-banana-frame-${clipIndex}`, async () => {
        let keys;
        try {
          keys = await loadDecryptedKeys(userId, ['gemini']);
        } catch (err) {
          if (err instanceof MissingProviderKeyError)
            return { ok: false as const, error: err.message, costUsd: 0 };
          throw err;
        }

        // For clips 1+: pull clip 0's frame as a reference so Gemini
        // anchors the character + lighting + scene to it. Falls back
        // gracefully if the reference download fails — we still get
        // an image, just without the chain.
        let referenceImageBase64: string | undefined;
        let referenceImageMimeType: string | undefined;
        if (useReferenceFromClip0) {
          try {
            const ref = await downloadGeneratedImageAsBase64({
              userId,
              jobId,
              variantIndex: 0,
              filenamePrefix: 'kling-frame-',
            });
            referenceImageBase64 = ref.base64;
            referenceImageMimeType = ref.mimeType;
          } catch (err) {
            console.log(
              `[kling-clip-${clipIndex}] reference download failed; proceeding without anchor: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const prompt = useReferenceFromClip0
          ? continuationImagePrompt(manual, clip)
          : buildImagePromptForClip(manual, clip);

        const image = await callGeminiImage({
          userId,
          apiKey: keys.gemini!,
          prompt,
          referenceImageBase64,
          referenceImageMimeType,
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
            variantIndex: clipIndex,
            imageBase64: image.imageBase64,
            mimeType: image.imageMimeType,
            filenamePrefix: 'kling-frame-',
          });
          return { ok: true as const, publicUrl: upload.publicUrl, costUsd: image.costUsd };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ok: false as const,
            error: `First-frame upload failed: ${msg}`,
            costUsd: image.costUsd,
          };
        }
      });

      if (!frameResult.ok) {
        console.log(`[kling-clip-${clipIndex}] nano-banana frame failed: ${frameResult.error}`);
        return { clipIndex, ok: false, costUsd: frameResult.costUsd, error: frameResult.error };
      }

      const submitResult = await step.run(`kling-submit-${clipIndex}`, async () => {
        let keys;
        try {
          keys = await loadDecryptedKeys(userId, ['kling']);
        } catch (err) {
          if (err instanceof MissingProviderKeyError)
            return { ok: false as const, error: err.message };
          throw err;
        }
        const prompt = buildKlingSubmitPrompt(manual, clip);

        return submitKlingVideo({
          userId,
          apiKey: keys.kling!,
          prompt,
          durationSeconds: (clip.duration ?? CLIP_DURATION_SECONDS) <= 5 ? 5 : 10,
          aspectRatio: '9:16',
          startImageUrl: frameResult.publicUrl,
          generationJobId: jobId,
        });
      });

      if (!submitResult.ok || !('predictionId' in submitResult) || !submitResult.predictionId) {
        const err =
          'errorMessage' in submitResult
            ? submitResult.errorMessage
            : 'error' in submitResult
              ? submitResult.error
              : 'submit failed';
        console.log(`[kling-clip-${clipIndex}] submit failed: ${err}`);
        return { clipIndex, ok: false, costUsd: frameResult.costUsd, error: err };
      }

      let videoUrl: string | undefined;
      let pollCostUsd = 0;
      let pollError: string | undefined;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await step.sleep(`kling-poll-${clipIndex}-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
        const tick = await step.run(`kling-check-${clipIndex}-${attempt}`, async () => {
          const keys = await loadDecryptedKeys(userId, ['kling']);
          return checkKlingPrediction({
            userId,
            apiKey: keys.kling!,
            predictionId: submitResult.predictionId!,
            generationJobId: jobId,
          });
        });
        if (tick.status === 'completed') {
          videoUrl = tick.videoUrl;
          pollCostUsd = tick.costUsd;
          break;
        }
        if (tick.status === 'failed') {
          pollError = tick.errorMessage ?? 'Kling clip failed';
          break;
        }
      }

      if (!videoUrl) {
        const err =
          pollError ??
          `Kling clip timed out after ${POLL_MAX_ATTEMPTS} polls ` +
            `(${POLL_INTERVAL_SECONDS}s interval = ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS) / 60} min ceiling)`;
        console.log(`[kling-clip-${clipIndex}] ${err}`);
        return {
          clipIndex,
          ok: false,
          costUsd: pollCostUsd + frameResult.costUsd,
          error: err,
        };
      }

      await step.run(`write-clip-${clipIndex}`, async () => {
        const db = getDb();
        await db.insert(schema.generatedCreatives).values({
          userId,
          generationJobId: jobId,
          fileUrl: videoUrl!,
          aspectRatio: '9:16',
          status: 'ready_for_review',
          format: 'kling_3_multi_clip',
          clipIndex,
          isClipPart: true,
          generationMetadata: {
            character_prompt: manual.characterPrompt,
            set_prompt: manual.setPrompt,
            video_prompt: clip.videoPrompt,
            image_prompt: clip.imagePrompt,
            dialogue: clip.dialogue,
            motion_type: clip.motionType,
            first_frame_url: frameResult.publicUrl,
            clip_index: clipIndex,
            reference_chain: useReferenceFromClip0,
          },
        });
      });

      return {
        clipIndex,
        ok: true,
        costUsd: pollCostUsd + frameResult.costUsd,
        videoUrl,
      };
    };

    // Polish-9.12: clip 0 serialized first (the "Master First Frame"
    // per the universal-ugc-master-prompt). Its Nano Banana output is
    // pulled by clips 1+ as a reference image so every subsequent
    // frame anchors to the same character + scene. Without this chain
    // each clip drew a fresh face and the variant looked like 16
    // different actors stitched together.
    if (manual.clips.length > 0) {
      const r0 = await processClip(0, manual.clips[0]!, false);
      totalCost += r0.costUsd;
      if (r0.ok) {
        successCount++;
        if (r0.videoUrl) clipVideoUrls.push({ clipIndex: 0, videoUrl: r0.videoUrl });
      }
    }

    // Clips 1+ run in parallel batches, all using clip 0's frame as
    // the reference image (downloaded inside each step.run).
    for (let batchStart = 1; batchStart < manual.clips.length; batchStart += CONCURRENCY) {
      const batch = manual.clips.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.all(
        batch.map((clip, idxInBatch) => processClip(batchStart + idxInBatch, clip, true)),
      );
      for (const r of results) {
        totalCost += r.costUsd;
        if (r.ok) successCount++;
        if (r.ok && r.videoUrl)
          clipVideoUrls.push({ clipIndex: r.clipIndex, videoUrl: r.videoUrl });
      }
    }

    // Polish-9.7: fail-fast when zero clips succeed. The previous code
    // marked the job 'completed' with 0 generated_creatives rows, which
    // looked like a successful run in the UI but produced nothing.
    const outcome = decideKlingJobOutcome({
      successCount,
      totalClips: manual.clips.length,
      clipsPerVariant: CLIPS_PER_VARIANT,
    });
    if (outcome.kind === 'fail') {
      console.log(`[kling-job] 0 of ${manual.clips.length} clips succeeded — marking job failed`);
      await markJobFailed(jobId, userId, outcome.error, totalCost);
      return { jobId, mode, generated: 0, totalCost };
    }

    // Polish-9.18: trim leading/trailing silence on each clip before
    // stitching, so the final composite has no dead-air at clip
    // boundaries. Per-clip step.run, each one falls back to the raw
    // URL on trim failure. Skipped entirely when REPLICATE_AUDIO_TRIM
    // _MODEL_ID is unset (Polish-9.17 behavior).
    const orderedRawClips = [...clipVideoUrls].sort((a, b) => a.clipIndex - b.clipIndex);
    const finalClipUrls: string[] = orderedRawClips.map((c) => c.videoUrl);
    let trimmedCount = 0;
    if (isAudioTrimEnabled() && orderedRawClips.length > 0) {
      for (let i = 0; i < orderedRawClips.length; i++) {
        const raw = orderedRawClips[i]!;
        const trimResult = await step.run(`trim-clip-${raw.clipIndex}`, async () => {
          let keys;
          try {
            keys = await loadDecryptedKeys(userId, ['kling']);
          } catch (err) {
            if (err instanceof MissingProviderKeyError)
              return { ok: false as const, error: err.message, costUsd: 0 };
            throw err;
          }
          const submit = await submitAudioTrim({
            userId,
            apiKey: keys.kling!,
            videoUrl: raw.videoUrl,
            generationJobId: jobId,
          });
          if (!submit.ok || !submit.predictionId) {
            return {
              ok: false as const,
              error: submit.errorMessage ?? 'trim submit failed',
              costUsd: 0,
            };
          }
          const predictionId = submit.predictionId;
          let trimmedUrl: string | undefined;
          let cost = 0;
          let trimError: string | undefined;
          for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
            await new Promise((res) => setTimeout(res, POLL_INTERVAL_SECONDS * 1000));
            const tick = await checkAudioTrim({
              userId,
              apiKey: keys.kling!,
              predictionId,
              generationJobId: jobId,
            });
            if (tick.status === 'completed') {
              trimmedUrl = tick.videoUrl;
              cost = tick.costUsd;
              break;
            }
            if (tick.status === 'failed') {
              trimError = tick.errorMessage ?? 'trim failed';
              break;
            }
          }
          if (!trimmedUrl) {
            return {
              ok: false as const,
              error: trimError ?? `trim timed out for clip ${raw.clipIndex}`,
              costUsd: cost,
            };
          }
          return { ok: true as const, trimmedUrl, costUsd: cost };
        });

        totalCost += trimResult.costUsd;
        if (trimResult.ok) {
          finalClipUrls[i] = trimResult.trimmedUrl;
          trimmedCount++;
        } else {
          console.log(
            `[kling-trim] clip ${raw.clipIndex} trim failed: ${trimResult.error}; using raw URL`,
          );
        }
      }
      if (trimmedCount === 0) {
        console.log('[kling-trim] all clips using untrimmed URLs');
      } else {
        console.log(`[kling-trim] ${trimmedCount}/${orderedRawClips.length} clips trimmed`);
      }
    } else if (!isAudioTrimEnabled()) {
      console.log('[kling-trim] audio trim disabled, using raw clip URLs');
    }

    // Polish-9.12: stitch clips into one final composite via Replicate
    // ffmpeg-concat. Skipped when REPLICATE_VIDEO_CONCAT_MODEL_ID is
    // unset; per-clip rows remain so the user can still download
    // individually. Stitching failure is non-fatal — clips stay.
    // Polish-11: hoisted so the post-stitch ElevenLabs + lipsync
    // block (below the isVideoConcatEnabled branch) can read it.
    let stitchedUrl: string | undefined;
    if (isVideoConcatEnabled() && finalClipUrls.length >= 2) {
      const orderedUrls = finalClipUrls;

      const stitchSubmit = await step.run('stitch-submit', async () => {
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

      let stitchCost = 0;
      if (stitchSubmit.ok && 'predictionId' in stitchSubmit && stitchSubmit.predictionId) {
        const predictionId = stitchSubmit.predictionId;
        for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
          await step.sleep(`stitch-poll-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
          const tick = await step.run(`stitch-check-${attempt}`, async () => {
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
            stitchCost = tick.costUsd;
            break;
          }
          if (tick.status === 'failed') {
            console.log(`[kling-stitch] failed: ${tick.errorMessage ?? 'unknown'}`);
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
        console.log(`[kling-stitch] submit failed: ${err}; per-clip rows remain`);
      }

      if (stitchedUrl) {
        totalCost += stitchCost;
        await step.run('write-composite', async () => {
          const db = getDb();
          await db.insert(schema.generatedCreatives).values({
            userId,
            generationJobId: jobId,
            fileUrl: stitchedUrl!,
            aspectRatio: '9:16',
            status: 'ready_for_review',
            format: 'kling_3_final_composite',
            isClipPart: false,
            generationMetadata: {
              source_clip_count: orderedUrls.length,
              source_clip_urls: orderedUrls,
              character_prompt: manual.characterPrompt,
              set_prompt: manual.setPrompt,
            },
          });
        });
        console.log(`[kling-stitch] composite written: ${stitchedUrl}`);
      } else {
        console.log(
          `[kling-stitch] no composite produced; ${clipVideoUrls.length} per-clip rows kept`,
        );
      }
    } else if (!isVideoConcatEnabled()) {
      console.log(
        '[kling-stitch] REPLICATE_VIDEO_CONCAT_MODEL_ID not set; skipping stitching. Per-clip rows kept.',
      );
    }

    // Polish-11: ElevenLabs continuous TTS + Replicate lipsync. Runs
    // only when there's a stitched composite AND at least one dialogue
    // line in the manual. Failures are non-fatal — the silent
    // composite + per-clip rows remain so the job is still useful.
    if (stitchedUrl) {
      const continuousDialogue = extractContinuousDialogue(manual.clips);
      if (continuousDialogue.length === 0) {
        console.log('[kling-tts] no dialogue extracted; final = silent composite');
      } else {
        const ttsResult = await step.run('elevenlabs-tts', async () => {
          let keys;
          try {
            keys = await loadDecryptedKeys(userId, ['elevenlabs']);
          } catch (err) {
            if (err instanceof MissingProviderKeyError)
              return { ok: false as const, error: err.message, costUsd: 0 };
            throw err;
          }
          const tts = await submitElevenLabsTts({
            userId,
            apiKey: keys.elevenlabs!,
            text: continuousDialogue,
            voiceId: getDefaultElevenLabsVoiceId(),
            generationJobId: jobId,
          });
          if (!tts.ok || !tts.audioBase64) {
            return {
              ok: false as const,
              error: tts.errorMessage ?? 'ElevenLabs TTS returned no audio',
              costUsd: tts.costUsd,
            };
          }
          try {
            const upload = await uploadGeneratedAudio({
              userId,
              jobId,
              audioBase64: tts.audioBase64,
              mimeType: tts.contentType ?? 'audio/mpeg',
              filename: 'voiceover',
            });
            return {
              ok: true as const,
              audioUrl: upload.publicUrl,
              costUsd: tts.costUsd,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              ok: false as const,
              error: `Audio upload failed: ${msg}`,
              costUsd: tts.costUsd,
            };
          }
        });

        totalCost += ttsResult.costUsd;
        if (!ttsResult.ok) {
          console.log(`[kling-tts] failed: ${ttsResult.error}; final = silent composite`);
        } else if (!isLipsyncEnabled()) {
          console.log(
            '[kling-lipsync] REPLICATE_LIPSYNC_MODEL_ID not set; final = silent composite (TTS audio uploaded for manual mux)',
          );
        } else {
          const lipsyncSubmit = await step.run('lipsync-submit', async () => {
            let keys;
            try {
              keys = await loadDecryptedKeys(userId, ['kling']);
            } catch (err) {
              if (err instanceof MissingProviderKeyError)
                return { ok: false as const, error: err.message };
              throw err;
            }
            return submitLipsync({
              userId,
              apiKey: keys.kling!,
              videoUrl: stitchedUrl!,
              audioUrl: ttsResult.audioUrl,
              generationJobId: jobId,
            });
          });

          let lipsyncedUrl: string | undefined;
          let lipsyncCost = 0;
          if (lipsyncSubmit.ok && 'predictionId' in lipsyncSubmit && lipsyncSubmit.predictionId) {
            const predictionId = lipsyncSubmit.predictionId;
            for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
              await step.sleep(`lipsync-poll-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
              const tick = await step.run(`lipsync-check-${attempt}`, async () => {
                const keys = await loadDecryptedKeys(userId, ['kling']);
                return checkLipsync({
                  userId,
                  apiKey: keys.kling!,
                  predictionId,
                  generationJobId: jobId,
                });
              });
              if (tick.status === 'completed') {
                lipsyncedUrl = tick.videoUrl;
                lipsyncCost = tick.costUsd;
                break;
              }
              if (tick.status === 'failed') {
                console.log(`[kling-lipsync] failed: ${tick.errorMessage ?? 'unknown'}`);
                break;
              }
            }
          } else {
            const err =
              'errorMessage' in lipsyncSubmit
                ? lipsyncSubmit.errorMessage
                : 'error' in lipsyncSubmit
                  ? lipsyncSubmit.error
                  : 'submit failed';
            console.log(`[kling-lipsync] submit failed: ${err}`);
          }

          if (lipsyncedUrl) {
            totalCost += lipsyncCost;
            await step.run('write-lipsynced', async () => {
              const db = getDb();
              await db.insert(schema.generatedCreatives).values({
                userId,
                generationJobId: jobId,
                fileUrl: lipsyncedUrl!,
                aspectRatio: '9:16',
                status: 'ready_for_review',
                format: 'kling_multi_clip_lipsynced',
                isClipPart: false,
                generationMetadata: {
                  silent_composite_url: stitchedUrl,
                  audio_url: ttsResult.audioUrl,
                  source_clip_count: clipVideoUrls.length,
                  character_prompt: manual.characterPrompt,
                  set_prompt: manual.setPrompt,
                  dialogue_chars: continuousDialogue.length,
                },
              });
            });
            console.log(`[kling-lipsync] lipsynced composite written: ${lipsyncedUrl}`);
          } else {
            console.log('[kling-lipsync] no lipsynced URL produced; final = silent composite');
          }
        }
      }
    }

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: outcome.variantCount,
      actualCostUsd: totalCost,
      provider: 'kling',
      path: 'kling-multi-clip',
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

// =========================================================================
// Parser
// =========================================================================

interface ClipSpec {
  /** 1-indexed clip number derived from the [USE IMAGE X] directive's X. */
  clipNumber: number;
  /** The image index this clip animates from (same as clipNumber by construction). */
  startingFrameImage: number;
  /**
   * Full Kling prompt body — everything from this clip's [USE IMAGE X]
   * directive to the next clip's directive (or end of Section C). Sent
   * to Kling verbatim because Kling 3.0's grammar consumes the bracket
   * directives natively.
   */
  videoPrompt: string;
  dialogue?: string;
  duration?: number;
  motionType?: string;
  /**
   * Optional clip-specific image prompt. Polish-9.10 no longer extracts
   * per-image entries from Section B (too format-variable); always
   * undefined. The worker falls back to character + set + section-B
   * imageGuidance + clip.videoPrompt via buildImagePromptForClip.
   */
  imagePrompt?: string;
}

interface ProductionManual {
  characterPrompt: string;
  setPrompt: string;
  /**
   * Section B body captured as one string — passed to Nano Banana
   * alongside character + set + clip context so the first frame can
   * reference whatever Claude wrote about images.
   */
  imageGuidance: string;
  clips: ClipSpec[];
}

/**
 * Polish-9.7: pure decision for whether a finished clip loop should
 * mark the job 'failed' (zero successes) or 'completed' (at least one).
 * Exported for unit tests. Mirrored inline in the Inngest function so
 * step boundaries don't need re-mapping.
 */
export function decideKlingJobOutcome(input: {
  successCount: number;
  totalClips: number;
  clipsPerVariant: number;
}): { kind: 'fail'; error: string } | { kind: 'complete'; variantCount: number } {
  if (input.successCount === 0) {
    return {
      kind: 'fail',
      error: `All ${input.totalClips} clips failed. Check per-clip errors in the Inngest run.`,
    };
  }
  return {
    kind: 'complete',
    variantCount: Math.ceil(input.successCount / input.clipsPerVariant),
  };
}

/**
 * Polish-9.10: anchor clip parsing on the [USE IMAGE X AS STARTING
 * FRAME] directive — the only thing the master prompt forces Claude
 * to emit verbatim ("Three Mandatory Elements — Always Include").
 * Polish-9.7 / 9.8 / 9.9 each chased a different surrounding-markdown
 * format (JSON, `### Clip N` + `**Field:**`, em-dash separators) and
 * each failed in production on a slightly different rendering. The
 * bracket directives don't vary, so we anchor on them instead.
 *
 * Strategy:
 *   1. Locate SECTION C header (markdown-decoration-tolerant).
 *   2. Scan for every [USE IMAGE N AS STARTING FRAME] directive.
 *   3. Each directive is a clip; body = text from this directive to
 *      the next (or end of Section C). Sent to Kling verbatim because
 *      Kling 3.0's grammar consumes [USE IMAGE X], Subject:, and
 *      [GENERATE NATIVE AUDIO...] natively.
 *   4. Section B body captured whole as `imageGuidance` and passed to
 *      Nano Banana — no per-image extraction (too format-variable).
 */
export function parseProductionManual(
  raw: unknown,
): { ok: true; manual: ProductionManual } | { ok: false; error: string } {
  if (raw == null || typeof raw !== 'string') {
    return { ok: false, error: 'Claude returned no text for the manual.' };
  }

  const text = stripCodeFences(raw);
  const sectionA = sliceSection(text, 'A');
  const characterPrompt = extractGlobalPrompt(sectionA, 'Character');
  const setPrompt = extractGlobalPrompt(sectionA, 'Set');

  if (!characterPrompt.trim()) {
    return { ok: false, error: errorWithExcerpt('Manual is missing characterPrompt', raw, 500) };
  }
  if (!setPrompt.trim()) {
    return { ok: false, error: errorWithExcerpt('Manual is missing setPrompt', raw, 500) };
  }

  const imageGuidance = sliceSection(text, 'B');

  const sectionC = sliceSectionC(text);
  if (sectionC === null) {
    return {
      ok: false,
      error: `No SECTION C header found in manual. First 1000 chars: ${raw.slice(0, 1000)}`,
    };
  }

  const clips = parseClipsFromDirectives(sectionC);
  if (clips.length === 0) {
    // Dump the body so the next failure shows EXACTLY what Claude emitted.
    console.log('[kling-manual] Section C body (first 2000 chars):', sectionC.slice(0, 2000));
    return {
      ok: false,
      error:
        `Section C has no [USE IMAGE X AS STARTING FRAME] directives. ` +
        `Claude likely formatted clips incorrectly. Section C first 2000 chars: ` +
        sectionC.slice(0, 2000),
    };
  }

  const blank = clips.findIndex((c) => !c.videoPrompt.trim());
  if (blank >= 0) {
    return { ok: false, error: `Clip ${blank + 1} has an empty video prompt` };
  }

  console.log(`[kling-manual] extracted ${clips.length} clips with directives.`);
  return { ok: true, manual: { characterPrompt, setPrompt, imageGuidance, clips } };
}

function errorWithExcerpt(prefix: string, raw: string, n: number): string {
  return `${prefix}. First ${n} chars: ${raw.slice(0, n)}`;
}

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * Slice `SECTION X — title\n...` up to next `SECTION Y` or EOF.
 * Polish-9.16: tolerates `**` bold wrapping around the heading
 * (`## **SECTION A — ...**`) — the shape Claude emits in production.
 */
function sliceSection(text: string, letter: 'A' | 'B' | 'C'): string {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:#{0,6}\\s*)?\\**\\s*SECTION\\s+${letter}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*(?:#{0,6}\\s*)?\\**\\s*SECTION\\s+[A-Z]\\b|$)`,
    'i',
  );
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : '';
}

/**
 * Like sliceSection('C') but distinguishes "absent" from "empty". The
 * worker needs to surface a specific "no SECTION C header" error when
 * Claude omits the section entirely. Same bold-wrap tolerance as
 * sliceSection (Polish-9.16).
 */
function sliceSectionC(text: string): string | null {
  const re =
    /(?:^|\n)\s*(?:#{0,6}\s*)?\**\s*SECTION\s+C\b[^\n]*\n([\s\S]*?)(?=\n\s*(?:#{0,6}\s*)?\**\s*SECTION\s+[D-Z]\b|$)/i;
  const m = text.match(re);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

/**
 * Extract `Global <Kind> Prompt: <value>` from Section A. Tolerates:
 *   - Plain `Global Character Prompt:` (Forge fixture style)
 *   - `**Global Character Prompt:**` (bold)
 *   - `### Global Character Prompt:` (markdown heading — Polish-9.16,
 *      the shape Claude Sonnet 4 emits in production)
 *   - `### **Global Character Prompt:**` (heading + bold)
 *   - Polish-13.1: `### 🧍 GLOBAL CHARACTER PROMPT — "JOHN"` (Sonnet
 *     4.6 form: emoji prefix, em-dash separator, body on subsequent
 *     lines inside a triple-backtick code block)
 *
 * Two-pattern strategy: try the colon form first (covers every legacy
 * variant + the production Sonnet 4 shape with multi-line capture),
 * fall back to the heading-only form (Sonnet 4.6). On either match,
 * if the captured body holds a triple-backtick code block with
 * meaningful content, that's preferred over the raw body — Sonnet 4.6
 * wraps the actual prompt in a fenced block with one-line decorative
 * labels above it.
 *
 * Boundary symmetry: both lookaheads also tolerate the emoji/decoration
 * prefix so the next "Global X Prompt" subsection is still recognized
 * as the stop marker regardless of which format the manual uses.
 */
function extractGlobalPrompt(sectionA: string, kind: 'Character' | 'Set'): string {
  if (!sectionA) return '';
  // Pattern 1 — legacy + Sonnet 4 production: "Global X Prompt:" form.
  // Value sits after the colon (same line or wrapping to subsequent
  // lines). Optional H1-H6 heading prefix, bold wrap, and Polish-13.1
  // emoji prefix.
  const colonRe = new RegExp(
    `(?:^|\\n)\\s*#{0,6}\\s*(?:[^\\w\\s*\\n]+\\s*)?\\**\\s*Global\\s+${kind}\\s+Prompt\\s*\\**\\s*:\\s*\\**\\s*` +
      `([\\s\\S]+?)(?=\\n\\s*#{0,6}\\s*(?:[^\\w\\s*\\n]+\\s*)?\\**\\s*Global\\s+\\w+\\s+Prompt\\b|\\n\\s*(?:#+\\s*)?\\**\\s*SECTION\\s+[A-Z]\\b|$)`,
    'i',
  );
  const colonMatch = sectionA.match(colonRe);
  if (colonMatch && colonMatch[1] && colonMatch[1].trim().length > 0) {
    return cleanPromptBody(colonMatch[1]);
  }
  // Pattern 2 — Polish-13.1 / Sonnet 4.6: "Global X Prompt — \"NAME\""
  // form. No colon after "Prompt"; em-dash or annotation absorbed via
  // `[^\\n]*`. Body captured from next line until the next subsection
  // / SECTION boundary.
  const headingRe = new RegExp(
    `(?:^|\\n)\\s*#{0,6}\\s*(?:[^\\w\\s*\\n]+\\s*)?\\**\\s*Global\\s+${kind}\\s+Prompt\\b[^\\n]*\\n` +
      `([\\s\\S]+?)(?=\\n\\s*#{0,6}\\s*(?:[^\\w\\s*\\n]+\\s*)?\\**\\s*Global\\s+\\w+\\s+Prompt\\b|\\n\\s*(?:#+\\s*)?\\**\\s*SECTION\\s+[A-Z]\\b|$)`,
    'i',
  );
  const headingMatch = sectionA.match(headingRe);
  if (headingMatch && headingMatch[1]) {
    return cleanPromptBody(headingMatch[1]);
  }
  return '';
}

/**
 * Polish-13.1: when the captured body contains a fenced code block
 * with substantial content (>50 chars), that's the actual prompt —
 * Sonnet 4.6 sticks the prompt inside ```...``` and uses the body
 * above it for a one-line label like "**Three-View Character
 * Sheet — Photorealistic, Front / Side / Back:**".
 */
function cleanPromptBody(body: string): string {
  const codeBlock = body.match(/```(?:\w+)?\s*\n([\s\S]+?)\n\s*```/);
  if (codeBlock && codeBlock[1] && codeBlock[1].trim().length > 50) {
    return codeBlock[1].replace(/\*\*/g, '').trim();
  }
  return body.replace(/\*\*/g, '').trim();
}

const USE_IMAGE_DIRECTIVE = /\[USE\s+IMAGE\s+(\d+)\s+AS\s+STARTING\s+FRAME\]/gi;

/**
 * Find every [USE IMAGE N AS STARTING FRAME] directive in Section C
 * body. Each directive starts a clip; body runs to the next directive.
 * Markdown decoration (### CLIP, **CLIP**, em-dashes, no header) is
 * ignored — the bracket directive is the sole anchor.
 *
 * Dedupe by image number (keep first), then sort ascending.
 */
function parseClipsFromDirectives(sectionC: string): ClipSpec[] {
  const re = new RegExp(USE_IMAGE_DIRECTIVE.source, 'gi');
  const anchors: { index: number; imageNum: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sectionC)) !== null) {
    anchors.push({ index: m.index, imageNum: Number(m[1]) });
  }
  if (anchors.length === 0) return [];

  const seen = new Set<number>();
  const clips: ClipSpec[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i]!;
    if (seen.has(cur.imageNum)) continue;
    seen.add(cur.imageNum);
    const next = anchors[i + 1];
    const body = sectionC.slice(cur.index, next ? next.index : sectionC.length).trim();

    const dialogue = extractDialogueDirective(body);
    const motionType = extractMotionTypeLine(body) || 'lip-sync';
    const duration = deriveDurationFromBody(body);

    clips.push({
      clipNumber: cur.imageNum,
      startingFrameImage: cur.imageNum,
      videoPrompt: body,
      dialogue: dialogue || undefined,
      duration,
      motionType,
      imagePrompt: undefined,
    });
  }
  clips.sort((a, b) => a.clipNumber - b.clipNumber);
  return clips;
}

function extractDialogueDirective(body: string): string {
  const m = body.match(/\[GENERATE\s+NATIVE\s+AUDIO[^\]]*\]:\s*"([^"]*)"/i);
  return m && m[1] ? m[1] : '';
}

function extractMotionTypeLine(body: string): string {
  const m = body.match(/(?:^|\n)\s*\**\s*motion[\s_-]?type\s*\**\s*:?\s*\**\s*([^\n]+)/i);
  if (!m || !m[1]) return '';
  return m[1]
    .replace(/\*\*/g, '')
    .replace(/[─━–—=_-]{4,}\s*$/, '')
    .trim();
}

function deriveDurationFromBody(body: string): number | undefined {
  // E.g. "00:00–00:06" or "00:00-00:06" in the header line within the body.
  const m = body.match(/(\d+):(\d+)\s*[–\-—]\s*(\d+):(\d+)/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return undefined;
  const startSec = Number(m[1]) * 60 + Number(m[2]);
  const endSec = Number(m[3]) * 60 + Number(m[4]);
  const diff = endSec - startSec;
  return diff > 0 && diff <= 30 ? diff : undefined;
}

/**
 * Polish-9.15: the master prompt's Section A is human context for
 * downstream workflows ("Photorealistic three-view character sheet,
 * front view, side view, back view of ..."). When that phrasing
 * lands directly in Nano Banana's prompt the model dutifully
 * produces a character reference sheet — three poses tiled in one
 * image — and Kling animates the sheet. Strip the offending tokens
 * here so the description survives but the format directive doesn't.
 */
export function stripCharacterSheetPattern(text: string): string {
  return text
    .replace(/photorealistic\s+three[\s-]view\s+character\s+sheet[^.]*\./gi, '')
    .replace(/three[\s-]view\s+character\s+sheet[^.]*\./gi, '')
    .replace(/front\s+view\s*,?\s*side\s+view\s*,?\s*(?:and\s+)?back\s+view[^.]*\./gi, '')
    .replace(/character\s+sheet/gi, 'character description')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Polish-9.15: defense-in-depth framing block. Forces Nano Banana
 * into single-subject single-view UGC selfie mode. Prepended to both
 * clip 0 and continuation prompts so any residual character-sheet
 * language in the source manual gets overridden.
 */
// Polish-19.0.4: moved to packages/jobs/src/lib/image-prompts.ts so the
// Kling Avatar v2 worker can share it. Re-exported below for back-compat
// with the existing Omni Flash worker import + Polish-11.2 test suite.
import { IMAGE_UGC_HARD_DIRECTIVE, UGC_FRAMING } from '../lib/image-prompts';
export { IMAGE_UGC_HARD_DIRECTIVE, UGC_FRAMING };

/**
 * Polish-9.18: SPEECH_PACING is prepended to the Kling prompt for any
 * clip whose body contains quoted dialogue. Kling-v2.6 defaults to a
 * theatrical slow delivery with dramatic pauses if not told otherwise;
 * UGC ads need conversational pace and zero dead-air.
 */
const SPEECH_PACING = [
  'Speech delivery: NATURAL CONVERSATIONAL pace, like a real person talking to a friend on the phone or recording a quick selfie video.',
  'Tempo: fast enough to fill the clip duration without dramatic pauses. NO filler silence at start. NO trailing silence at end. Dialogue begins immediately and continues to the end of the clip.',
  'Tone: casual, authentic, slightly imperfect.',
  'Performance: NOT theatrical, NOT slow-and-measured. Real-life speaking style.',
].join(' ');

/** Polish-9.18: true if the clip body contains a quoted dialogue string. */
export function hasQuotedDialogue(text: string): boolean {
  return /"[^"]{3,}"/.test(text);
}

/**
 * Polish-9.15: extract wardrobe / clothing phrasing from the
 * character description so continuation prompts can repeat it
 * verbatim. Without this, Nano Banana drifts on clothing color +
 * type between clips (the blue→green t-shirt drift the user
 * reported). Best-effort — returns empty string if no clear cue.
 */
export function extractWardrobeFromCharacter(text: string): string {
  if (!text) return '';
  const segments: string[] = [];
  // "wearing X" up to next comma/period.
  const wearing = text.match(/wearing\s+([^.]+?)(?:[.,]|$)/i);
  if (wearing && wearing[1]) segments.push(wearing[1].trim());
  // "in a Y shirt/dress/outfit/scrubs"
  const inA = text.match(
    /in\s+(?:a|an)\s+([^.]*?(?:shirt|dress|scrubs|outfit|jacket|hoodie|sweater|coat|uniform)[^.]*?)(?:[.,]|$)/i,
  );
  if (inA && inA[1]) segments.push(inA[1].trim());
  return segments.join('; ').replace(/\s+/g, ' ').trim();
}

/**
 * Build clip 0's Nano Banana prompt — the "Master First Frame" per
 * the master prompt's design. Strips the three-view character sheet
 * directive from Section A, drops Section B's imageGuidance (which
 * frequently contains "IMAGE 1, IMAGE 2..." that confuses the model
 * into producing multiple frames), prepends explicit UGC framing,
 * and lands the result as a single ONE-frame selfie. Clip 0's output
 * is what the reference chain anchors on, so any drift here
 * propagates to every subsequent clip.
 *
 * The legacy clip.imagePrompt path is preserved for callers that
 * pre-bake a per-clip image prompt; the UGC framing still wraps it.
 */
// Polish-19.0.4: IMAGE_UGC_HARD_DIRECTIVE moved to ../lib/image-prompts;
// re-exported at the top of this file for back-compat.

/**
 * Polish-12.6: explicit anti-celebrity steering for Nano Banana. The
 * scrubbers (Polish-12.3 / 12.3.1) catch celebrity NAMES in the
 * downstream text prompt, but Nano Banana can still hallucinate a
 * celebrity-resembling FACE from generic descriptors ("32yo woman
 * with dark hair, blue cotton t-shirt" → face that looks like Anne
 * Hathaway, etc.). Once that face is the reference frame, every Omni
 * Flash segment trips PROMINENT_PEOPLE_FILTER and no per-segment retry
 * with a fresh seed can recover.
 *
 * Appended to the END of buildImagePromptForClip output — Nano Banana
 * (and Gemini's image-gen family broadly) weights the tail of the
 * prompt heavily for the actual rendered subject.
 *
 * Exported so the test suite can pin the directive's presence and so
 * future direct callers can opt out if they need a different policy.
 */
export const ANTI_CELEBRITY_NANO_BANANA_DIRECTIVE = [
  'CRITICAL CONTENT REQUIREMENT:',
  'The character must be a completely fictional, generic everyday person with NO resemblance whatsoever to any real-world celebrity, actor, musician, athlete, politician, influencer, public figure, or famous person living or dead. The face should be unremarkable and generic — like someone you would pass on the street and immediately forget.',
  'DO NOT generate:',
  '- Faces resembling Brad Pitt, Tom Cruise, Leonardo DiCaprio, or any actor',
  '- Faces resembling Justin Bieber, Taylor Swift, Beyoncé, or any musician',
  '- Faces resembling LeBron James, Cristiano Ronaldo, or any athlete',
  '- Faces resembling Donald Trump, Barack Obama, or any politician',
  '- Faces resembling Kim Kardashian, MrBeast, or any influencer',
  '- Any face that could be reasonably mistaken for a famous person',
  'If the rendered face resembles ANY famous person living or dead, the output will be REJECTED by downstream content filters and the production pipeline fails. Generate a face that is intentionally forgettable and generic.',
].join('\n');

export function buildImagePromptForClip(
  manual: { characterPrompt: string; setPrompt: string; imageGuidance?: string },
  clip: ClipSpec,
): string {
  if (clip.imagePrompt && clip.imagePrompt.trim()) {
    return [
      IMAGE_UGC_HARD_DIRECTIVE,
      UGC_FRAMING,
      clip.imagePrompt,
      ANTI_CELEBRITY_NANO_BANANA_DIRECTIVE,
    ].join('\n\n');
  }
  // Polish-11.2: scrub the same caption / b-roll / audio-era language
  // out of the image-prompt inputs that Polish-10.5 strips from the
  // Kling video prompt. The reference deconstruction in Section A / B
  // describes the source ad's lower-thirds + product inserts — those
  // bleed into Nano Banana otherwise.
  const character = stripTextCaptionsBroll(stripCharacterSheetPattern(manual.characterPrompt));
  const scene = stripTextCaptionsBroll(manual.setPrompt);
  const clipDescription = stripTextCaptionsBroll(
    stripAudioEraArtifacts(
      clip.videoPrompt.replace(/\[USE\s+IMAGE\s+\d+\s+AS\s+STARTING\s+FRAME\]/gi, ''),
    ),
  );
  return [
    IMAGE_UGC_HARD_DIRECTIVE,
    UGC_FRAMING,
    `Character: ${character}`,
    `Scene/Set: ${scene}`,
    `Action this frame: ${clipDescription}`,
    'CRITICAL: ONE single frame, ONE camera angle. NO text, NO captions, NO overlays anywhere in the image. NOT a reference sheet. NOT multiple poses.',
    // Polish-12.6: anti-celebrity directive at the tail. Nano Banana
    // weights the tail heavily, so this lands closest to the actual
    // rendered subject.
    ANTI_CELEBRITY_NANO_BANANA_DIRECTIVE,
  ]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n');
}

/**
 * Prompt used for clips 1+ in the character-reference chain. Frames
 * the call as an EDIT operation against clip 0's image (passed in as
 * referenceImageBase64) using the master prompt's documented "Same-
 * Scene Continuations" pattern, so Gemini varies gesture/prop/
 * expression while preserving character identity, lighting, framing,
 * set, and (Polish-9.15) wardrobe. UGC framing repeated as defense
 * in depth — Nano Banana drifts on later clips otherwise.
 *
 * Polish-11.2: same caption / b-roll / audio-era scrub on inputs as
 * buildImagePromptForClip. IMAGE_UGC_HARD_DIRECTIVE prepended.
 */
export function continuationImagePrompt(
  manual: { characterPrompt: string; setPrompt: string },
  clip: ClipSpec,
): string {
  const character = stripTextCaptionsBroll(stripCharacterSheetPattern(manual.characterPrompt));
  const scene = stripTextCaptionsBroll(manual.setPrompt);
  const clipDescription = stripTextCaptionsBroll(
    stripAudioEraArtifacts(
      clip.videoPrompt.replace(/\[USE\s+IMAGE\s+\d+\s+AS\s+STARTING\s+FRAME\]/gi, ''),
    ),
  );
  const wardrobe = extractWardrobeFromCharacter(manual.characterPrompt);
  const lines = [
    IMAGE_UGC_HARD_DIRECTIVE,
    UGC_FRAMING,
    'Exact same framing as Image 1 — same character, same scene, same lighting.',
    `Now: ${clipDescription}`,
    `Character reference: ${character}`,
    `Set: ${scene}`,
    'Camera: same as Image 1. Deep focus on everything. No blur. Lighting: same as Image 1.',
  ];
  if (wardrobe) {
    lines.push(
      `Wardrobe: EXACTLY as in Image 1 — ${wardrobe}. Do NOT change clothing or accessories.`,
    );
  } else {
    lines.push(
      'Wardrobe: EXACTLY as in Image 1 — same clothing, same colors, same accessories. Do NOT change anything the character is wearing.',
    );
  }
  lines.push(
    'ABSOLUTELY NO phones, cameras, screens, social media UI, floating text, or digital overlays.',
  );
  return lines.join('\n\n');
}

// =========================================================================
// Polish-10.5: silent-Kling prompt hygiene
// =========================================================================

/**
 * Polish-10.5: detects when the configured Kling model is silent
 * (Kling 2.5 turbo pro). Silent models render quoted dialogue as
 * captions on screen — the worker must strip audio-era directives,
 * dialogue quotes, and b-roll/text-overlay language from prompts.
 *
 * Defaults to true (assume silent) when the env var is missing so a
 * fresh install gets the safer hygiene path even before the operator
 * pins a model id. Audio-capable callers (Kling 2.6 / Omni) set
 * KLING_MODEL_ID accordingly and get the existing behavior.
 */
export function isSilentKlingModel(modelId: string = process.env.KLING_MODEL_ID ?? ''): boolean {
  if (!modelId) return true;
  return /v2\.5/i.test(modelId) || /turbo[\s_-]?pro/i.test(modelId);
}

/**
 * Polish-10.5: hard UGC-only directive prepended to the silent-Kling
 * submit prompt. Suppresses on-screen text, b-roll, and multi-shot
 * composition that the model would otherwise lean into when it can't
 * make audio.
 */
export const SILENT_UGC_HARD_DIRECTIVE = [
  'PURE RAW UGC SELFIE VIDEO. Single character talking to phone camera in continuous unbroken shot.',
  'ABSOLUTELY NO text on screen. NO captions. NO subtitles. NO graphics. NO title cards. NO lower thirds. NO overlays. NO watermarks. NO logos.',
  'NO b-roll. NO cutaways. NO product shots. NO insert shots. NO scenery shots. NO transitions to other subjects.',
  'Camera stays on the character the entire time. Continuous unbroken handheld iPhone selfie shot.',
].join(' ');

/**
 * Polish-10.5: strip [GENERATE NATIVE AUDIO ...] directives, lip-sync
 * brackets, and inline quoted dialogue. Convert "X says: 'Y'" idioms
 * into action descriptions ("X talks about Y") so the silent model
 * doesn't render the quoted text as on-screen captions.
 */
export function stripAudioEraArtifacts(text: string): string {
  return text
    .replace(/\[GENERATE\s+NATIVE\s+AUDIO\s+AND\s+LIP-?SYNC[^\]]*\]\s*:\s*"[^"]*"/gi, '')
    .replace(/\[GENERATE\s+NATIVE\s+AUDIO\s+AND\s+LIP-?SYNC[^\]]*\]/gi, '')
    .replace(/\[GENERATE\s+NATIVE\s+AUDIO[^\]]*\]\s*:\s*"[^"]*"/gi, '')
    .replace(/\[GENERATE\s+NATIVE\s+AUDIO[^\]]*\]/gi, '')
    .replace(
      /\b(?:says|saying|said|tells|telling|exclaims|exclaiming)\s+"([^"]+)"/gi,
      (_, dialogue: string) => `talks about ${dialogue}`,
    )
    .replace(/"([^"]+)"/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Polish-10.5: drop sentences that explicitly call out on-screen
 * text, captions, overlays, b-roll, or cutaways. The reference-
 * deconstruction in Section A/B/C frequently mentions these because
 * source ads have them; for silent UGC we want them gone.
 */
export function stripTextCaptionsBroll(text: string): string {
  return text
    .replace(
      /[^.]*?\b(?:caption[s]?|subtitle[s]?|text\s+overlay|on[\s-]screen\s+text|graphic[s]?|title\s+card|lower\s+third|chyron|watermark|logo)\b[^.]*\.\s*/gi,
      '',
    )
    .replace(
      /[^.]*?\b(?:b[\s-]?roll|cutaway[s]?|insert\s+shot[s]?|product\s+shot[s]?|scenery\s+shot[s]?|montage|split\s+screen|picture[\s-]in[\s-]picture)\b[^.]*\.\s*/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Polish-10.5: build the prompt sent to submitKlingVideo per clip.
 * Splits behavior by model capability:
 *   - Silent Kling 2.5 turbo pro: aggressive scrub of audio-era
 *     directives, dialogue quotes, text/b-roll language; prepend the
 *     SILENT_UGC_HARD_DIRECTIVE; SPEECH_PACING is omitted (it
 *     mentions "dialogue" / "speech" which biases the silent model
 *     toward rendering captions).
 *   - Audio-capable (Kling 2.6, anything not matching the silent
 *     heuristic): preserve the Polish-9.18 behavior — prepend
 *     SPEECH_PACING when the clip has dialogue, append the
 *     [GENERATE NATIVE AUDIO...] directive if not already present in
 *     the body.
 *
 * Exported so the test suite can drive the silent / audio branches
 * deterministically.
 */
export function buildKlingSubmitPrompt(
  manual: { characterPrompt: string; setPrompt: string },
  clip: ClipSpec,
  silent: boolean = isSilentKlingModel(),
): string {
  if (silent) {
    const scrubbedBody = stripTextCaptionsBroll(stripAudioEraArtifacts(clip.videoPrompt));
    const scrubbedCharacter = stripTextCaptionsBroll(
      stripCharacterSheetPattern(manual.characterPrompt),
    );
    const scrubbedSet = stripTextCaptionsBroll(manual.setPrompt);
    return [
      SILENT_UGC_HARD_DIRECTIVE,
      UGC_FRAMING,
      `Character: ${scrubbedCharacter}`,
      `Scene/Set: ${scrubbedSet}`,
      `Action this clip: ${scrubbedBody}`,
    ]
      .filter((s) => s && s.trim().length > 0)
      .join('\n\n');
  }

  // Audio-capable path (Polish-9.18 behavior preserved).
  const hasDialogue = hasQuotedDialogue(clip.videoPrompt) || Boolean(clip.dialogue);
  return [
    hasDialogue ? SPEECH_PACING : '',
    clip.videoPrompt,
    clip.dialogue && !/GENERATE NATIVE AUDIO AND LIP-SYNC/i.test(clip.videoPrompt)
      ? `[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "${clip.dialogue}"`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Polish-11: build one continuous TTS script from every clip's
 * dialogue, in clip order. Prefers clip.dialogue (already parsed),
 * falls back to scanning the body for the `[GENERATE NATIVE AUDIO
 * AND LIP-SYNC TO EXACT DIALOGUE]: "..."` bracket form, then to
 * quoted strings. Dedupes consecutive identical lines so a clip
 * body that duplicates the parser's dialogue field doesn't echo
 * twice. Returns '' when no usable dialogue is found — the worker
 * skips the TTS + lipsync steps and falls back to the silent
 * composite.
 */
export function extractContinuousDialogue(clips: ClipSpec[]): string {
  const lines: string[] = [];
  let prev = '';
  for (const clip of clips) {
    const line = pickClipDialogue(clip).trim();
    if (!line || line === prev) continue;
    lines.push(line);
    prev = line;
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function pickClipDialogue(clip: ClipSpec): string {
  if (clip.dialogue && clip.dialogue.trim()) return clip.dialogue.trim();
  const body = clip.videoPrompt ?? '';
  const bracket = body.match(
    /\[GENERATE\s+NATIVE\s+AUDIO\s+AND\s+LIP-?SYNC[^\]]*\]\s*:\s*"([^"]+)"/i,
  );
  if (bracket && bracket[1]) return bracket[1].trim();
  const audioBracket = body.match(/\[GENERATE\s+NATIVE\s+AUDIO[^\]]*\]\s*:\s*"([^"]+)"/i);
  if (audioBracket && audioBracket[1]) return audioBracket[1].trim();
  const quoted = body.match(/"([^"]{4,})"/);
  if (quoted && quoted[1]) return quoted[1].trim();
  return '';
}

void logAuditEvent;
