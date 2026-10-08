/**
 * Polish-30.0.17 Commit 189: per-variant Avatar IV worker.
 *
 * One Inngest invocation = one variant render. The parent
 * `generate-polish28-variations-ugc` dispatches N of these events
 * in parallel (one per Claude-generated persona+script pair),
 * waits for N `polish28-variant.completed` events to come back, and
 * then marks the parent job done.
 *
 * Why: polish28_variations's old pattern was `Promise.all` over
 * per-variant renderOneVariant calls inside ONE Inngest function.
 * Each variant hit step.sleep in its poll loop; two parallel
 * variants both sleeping tripped Inngest v3's checkpoint model
 * (classic documented pitfall). N=1 worked; N≥2 deadlocked.
 *
 * Separate-event dispatch gives true isolation: each variant runs
 * as its own Inngest function invocation with its own step
 * state. Variants can retry independently without cross-
 * contamination. This also unblocks bulk-user workflows where
 * someone fires 10+ variations in one job.
 *
 * Keys: do NOT cross the event boundary (plaintext secrets must
 * not persist in Inngest step state). Re-loaded here from the DB
 * via loadDecryptedKeys using the userId in the event payload.
 *
 * Voice match: done ONCE on the parent (which already has the
 * full HeyGen voice roster from Step F), result passed down in the
 * event. Saves N × fetch-voices calls.
 */
import { Buffer } from 'node:buffer';
import {
  cloneCharacterReferenceImage,
  composeNanoBananaCharacterClonePrompt,
  estimateHeygenAvatarIvCostUsd,
  isTerminalAvatarIvStatus,
  submitHeygenAvatarIvGeneration,
  checkHeygenAvatarIvStatus,
  uploadHeygenImageAsset,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { eq } from 'drizzle-orm';
import { POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { loadDecryptedKeys } from '../lib/load-keys';
import {
  assertNoUndefinedForPostgres,
  guardedStepRun,
} from '../lib/assert-no-undefined-for-postgres';
import { safeInngestStepReturn } from '../lib/strip-undefined';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';
import type { Polish28VariationEntry } from '../lib/polish28-variations-prompt';

console.log(`[jobs.generate-polish28-variant] cold start — POLISH_VERSION=${POLISH_VERSION}`);

const HEYGEN_POLL_MAX_ATTEMPTS = 90;
const HEYGEN_POLL_INTERVAL_SECONDS = 15;

export interface Polish28VariantEventPayload {
  jobId: string;
  userId: string;
  variantIndex: number;
  entry: Polish28VariationEntry;
  matchedVoice: {
    voice_id: string;
    name: string;
    gender?: string;
  };
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
    'polish28-variant:patchMetadata',
  );
  await db
    .update(schema.generationJobs)
    .set({ metadata: cleaned })
    .where(eq(schema.generationJobs.id, jobId));
}

export const generatePolish28Variant = inngest.createFunction(
  {
    id: 'generate-polish28-variant',
    name: 'Polish-28: single variant render (Avatar IV)',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish28-variant.requested' },
  async ({ event, step }) => {
    const data = event.data as Polish28VariantEventPayload;
    const { jobId, userId, variantIndex, entry, matchedVoice } = data;
    const stepSuffix = `v${variantIndex}`;

    try {
      // Step 0: re-load keys (DO NOT cross event boundary with plaintext)
      const keys = await guardedStepRun(step, `load-keys-${stepSuffix}`, async () => {
        const loaded = await loadDecryptedKeys(userId, ['gemini', 'heygen']);
        if (!loaded.gemini) throw new Error(`variant ${variantIndex} missing gemini key`);
        if (!loaded.heygen) throw new Error(`variant ${variantIndex} missing heygen key`);
        return safeInngestStepReturn({ gemini: loaded.gemini, heygen: loaded.heygen });
      });

      // Step 1: Nano Banana character (text-only, no source frame reference)
      const characterUpload = await guardedStepRun(
        step,
        `clone-character-${stepSuffix}`,
        async () => {
          const personaText =
            `Age: ${entry.persona.age_range}. Gender: ${entry.persona.gender}. ` +
            `Ethnicity: ${entry.persona.ethnicity}. Look: ${entry.persona.look}`;
          const prompt = composeNanoBananaCharacterClonePrompt(personaText);
          // 1x1 gray placeholder ref (same as polish28 variations main worker)
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
            throw new Error(
              `variant ${variantIndex} Nano Banana character failed: ${r.errorMessage ?? 'unknown'}`,
            );
          }
          const uploaded = await uploadGeneratedImage({
            userId,
            jobId,
            variantIndex,
            imageBase64: r.imageBase64,
            mimeType: r.imageMimeType ?? 'image/png',
            filenamePrefix: `polish28-var${variantIndex}-character-`,
          });
          return safeInngestStepReturn({
            publicUrl: uploaded.publicUrl,
            storagePath: uploaded.path,
            mimeType: r.imageMimeType ?? 'image/png',
            costUsd: r.costUsd,
          });
        },
      );

      // Step 2: Upload character to HeyGen
      const heygenImageKey = await guardedStepRun(
        step,
        `upload-heygen-image-${stepSuffix}`,
        async () => {
          const fetchRes = await fetch(characterUpload.publicUrl);
          if (!fetchRes.ok) {
            throw new Error(`variant ${variantIndex} character-fetch HTTP ${fetchRes.status}`);
          }
          const arr = await fetchRes.arrayBuffer();
          const bytes = new Uint8Array(arr);
          const characterMime =
            characterUpload.mimeType === 'image/jpeg' || characterUpload.mimeType === 'image/jpg'
              ? 'image/jpeg'
              : 'image/png';
          const r = await uploadHeygenImageAsset({
            userId,
            apiKey: keys.heygen,
            imageBytes: bytes,
            imageMimeType: characterMime,
            generationJobId: jobId,
          });
          if (!r.ok || !r.imageKey) {
            throw new Error(
              `variant ${variantIndex} HeyGen upload failed: ${r.errorMessage ?? 'unknown'}`,
            );
          }
          return safeInngestStepReturn({ imageKey: r.imageKey });
        },
      );

      // Step 3: Submit Avatar IV with image_key + script + voice_id
      const heygenVideoId = await guardedStepRun(step, `submit-heygen-${stepSuffix}`, async () => {
        const r = await submitHeygenAvatarIvGeneration({
          userId,
          apiKey: keys.heygen,
          imageKey: heygenImageKey.imageKey,
          script: entry.script,
          voiceId: matchedVoice.voice_id,
          videoTitle: `polish28_var_${jobId.slice(0, 8)}_${variantIndex}`,
          generationJobId: jobId,
        });
        if (!r.ok || !r.videoId) {
          throw new Error(
            `variant ${variantIndex} HeyGen submit failed: ${r.errorMessage ?? 'unknown'}`,
          );
        }
        return safeInngestStepReturn({ videoId: r.videoId });
      });

      // Step 4: Poll for completion. This is a plain step.run poll loop
      // with step.sleep in between — safe because this entire function
      // invocation is ONE variant. No cross-variant checkpoint collision.
      let finalVideoUrl: string | null = null;
      let finalDurationSeconds: number | null = null;
      for (let attempt = 0; attempt < HEYGEN_POLL_MAX_ATTEMPTS; attempt++) {
        const pollResult = await guardedStepRun(
          step,
          `poll-heygen-${stepSuffix}-${attempt}`,
          async () => {
            const r = await checkHeygenAvatarIvStatus({
              userId,
              apiKey: keys.heygen,
              videoId: heygenVideoId.videoId,
              generationJobId: jobId,
            });
            return safeInngestStepReturn({
              ok: r.ok,
              status: r.status,
              videoUrl: r.videoUrl ?? null,
              durationSeconds: r.durationSeconds ?? null,
              errorMessage: r.errorMessage ?? null,
            });
          },
        );
        if (!pollResult.ok || pollResult.status === 'failed') {
          throw new Error(
            `variant ${variantIndex} HeyGen failed after ${attempt + 1} polls: ${pollResult.errorMessage ?? 'unknown'}`,
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
        throw new Error(
          `variant ${variantIndex} HeyGen timed out after ${HEYGEN_POLL_MAX_ATTEMPTS} polls`,
        );
      }

      // Step 5: Download + upload final mp4 to Supabase
      const uploaded = await guardedStepRun(step, `upload-final-${stepSuffix}`, async () => {
        const r = await uploadGeneratedVideoFromUrl({
          userId,
          jobId,
          remoteUrl: finalVideoUrl!,
          filename: `polish28-var${variantIndex}-lipsync`,
          compress: true,
        });
        return safeInngestStepReturn({
          path: r.path,
          publicUrl: r.publicUrl,
          sizeBytes: r.sizeBytes,
        });
      });

      // Step 6: Persist creative row
      await guardedStepRun(step, `persist-creative-${stepSuffix}`, async () => {
        const db = getDb();
        const creativeRecord = assertNoUndefinedForPostgres(
          {
            userId,
            generationJobId: jobId,
            fileUrl: uploaded.publicUrl,
            hookVariantIndex: variantIndex,
            bodyVariantIndex: variantIndex,
            ctaVariantIndex: variantIndex,
            aspectRatio: '9:16' as const,
          },
          'polish28-variant:generated-creatives-insert',
        );
        await db
          .insert(schema.generatedCreatives)
          .values(creativeRecord as typeof schema.generatedCreatives.$inferInsert);
        return safeInngestStepReturn({ ok: true });
      });

      // Step 7: Patch per-variant metadata on parent job row
      const heygenCost = estimateHeygenAvatarIvCostUsd(finalDurationSeconds ?? 30);
      const variantCost = heygenCost + (characterUpload.costUsd ?? 0) + 0.02;
      await guardedStepRun(step, `patch-meta-${stepSuffix}`, async () => {
        await patchMetadata(jobId, {
          [`polish28_var_${variantIndex}_status`]: 'completed',
          [`polish28_var_${variantIndex}_persona`]: entry.persona,
          [`polish28_var_${variantIndex}_voice`]: {
            voice_id: matchedVoice.voice_id,
            name: matchedVoice.name,
            gender: matchedVoice.gender ?? null,
          },
          [`polish28_var_${variantIndex}_video_url`]: uploaded.publicUrl,
          [`polish28_var_${variantIndex}_cost_usd`]: variantCost,
        });
        return safeInngestStepReturn({ ok: true });
      });

      // Step 8: Fire completion event back to parent
      await step.sendEvent(`variant-complete-${stepSuffix}`, {
        name: 'generation/polish28-variant.completed',
        data: {
          jobId,
          variantIndex,
          ok: true,
          costUsd: variantCost,
          videoUrl: uploaded.publicUrl,
        },
      });

      void Buffer;
      return { ok: true, variantIndex, costUsd: variantCost };
    } catch (err) {
      // Fire failure completion so the parent can proceed instead of
      // waiting out its timeout. Also persist a per-variant error marker.
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[polish28-variant] ${jobId}:${variantIndex} failed:`, errorMessage);
      try {
        await patchMetadata(jobId, {
          [`polish28_var_${variantIndex}_status`]: 'failed',
          [`polish28_var_${variantIndex}_error`]: errorMessage.slice(0, 500),
        });
      } catch {
        // ignore secondary metadata-write failure
      }
      await step.sendEvent(`variant-complete-${stepSuffix}-failed`, {
        name: 'generation/polish28-variant.completed',
        data: {
          jobId,
          variantIndex,
          ok: false,
          error: errorMessage.slice(0, 500),
        },
      });
      return { ok: false, variantIndex, error: errorMessage };
    }
  },
);
