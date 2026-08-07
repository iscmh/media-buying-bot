/**
 * Polish-28.0.0 Commit 64: BYOK-only cloned-UGC pipeline worker.
 *
 * Steps (each its own guardedStepRun for per-step try/catch + logging):
 *   A. load-job                  fetch generation_jobs + concept
 *   B. mark-processing           update status + progress
 *   C. load-source-context       persona + source video URL from concepts
 *   D. condense-script           Claude → 30s-target UGC monologue
 *   E. extract-source-audio      ffmpeg extract + loop-mitigate → mp3 bytes
 *   F. clone-voice               ElevenLabs Instant Voice Clone → voice_id
 *   G. clone-or-reuse-character  Nano Banana Pro clone OR reuse from
 *                                concepts.metadata.polish28_character_reference
 *   H. tts-with-cloned-voice     ElevenLabs TTS → mp3 bytes → Supabase URL
 *   I. upload-heygen-image-asset upload character image bytes → image_key
 *   J. submit-heygen-avatar-iv   image_key + audio_url → video_id
 *   K. poll-heygen-status        chunked 1-shot-per-step polls
 *   L. upload-final-video        download from HeyGen → Supabase → publicUrl
 *   M. persist-creative          insert generated_creatives row
 *   N. cleanup-temp-voice        best-effort DELETE /v1/voices/{id}
 *
 * BYOK requirement: user must have all 4 keys connected (Claude,
 * Gemini, ElevenLabs, HeyGen). The generate form gates on this
 * upstream; the worker double-checks in the load-keys step to give
 * a clear NonRetriableError if any key vanished between submit +
 * execution.
 *
 * Output: 9:16 vertical video (locked per Polish-28 spec — no user
 * choice). HeyGen Avatar IV supports 9:16 or 16:9 only; 9:16 wins
 * for Meta Reels / TikTok / IG Reels affiliate creatives.
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  cloneCharacterReferenceImage,
  composeNanoBananaCharacterClonePrompt,
  createInstantVoiceClone,
  deleteElevenLabsVoice,
  estimateHeygenAvatarIvCostUsd,
  flattenPersonaForClonePrompt,
  isTerminalAvatarIvStatus,
  POLISH28_ASPECT_RATIO,
  POLISH28_TEMP_VOICE_NAME_PREFIX,
  submitElevenLabsTts,
  submitHeygenAvatarIvGeneration,
  checkHeygenAvatarIvStatus,
  uploadHeygenImageAsset,
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
import { extractSourceAudioLoopMitigated } from '../lib/extract-source-audio';
import {
  checkPolish25CondensedScript,
  composePolish25CondenserUserPrompt,
  POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT,
} from '../lib/polish25-claude-script-condenser-prompt';
import {
  uploadGeneratedAudio,
  uploadGeneratedImage,
  uploadGeneratedVideoFromUrl,
} from '../lib/storage';

console.log(`[jobs.generate-polish28-clone-ugc] cold start — POLISH_VERSION=${POLISH_VERSION}`);

const HEYGEN_POLL_MAX_ATTEMPTS = 30;
const HEYGEN_POLL_INTERVAL_SECONDS = 10;
/** Freshness window for reusing a cached Nano Banana Pro character clone. */
const CHARACTER_REF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

/** Read-modify-write for generation_jobs.metadata. Sanitizes patches
 *  before writing to guarantee no undefined values reach postgres-js. */
async function patchMetadata(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const row = await db.query.generationJobs.findFirst({
    where: eq(schema.generationJobs.id, jobId),
    columns: { metadata: true },
  });
  const existing = (row?.metadata ?? {}) as Record<string, unknown>;
  const cleaned = assertNoUndefinedForPostgres({ ...existing, ...patch }, 'polish28:patchMetadata');
  await db
    .update(schema.generationJobs)
    .set({ metadata: cleaned })
    .where(eq(schema.generationJobs.id, jobId));
}

/** Character-reference cache shape stored on concepts.metadata.polish28_character_reference. */
interface Polish28CharacterReference {
  storagePath: string;
  publicUrl: string;
  personaHash: string;
  createdAt: string;
  modelIdUsed: string;
}

function hashPersona(persona: string): string {
  // Cheap deterministic hash for cache-invalidation checks. Not
  // security-sensitive — collision-tolerant. FNV-1a 32-bit.
  let h = 2166136261;
  for (let i = 0; i < persona.length; i++) {
    h ^= persona.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export const generatePolish28CloneUgc = inngest.createFunction(
  {
    id: 'generate-polish28-clone-ugc',
    name: 'Polish-28: BYOK cloned-UGC pipeline (character + voice + lip-sync)',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish28-clone-ugc.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data as {
      jobId: string;
      userId: string;
      mode: 'mock' | 'live';
    };
    const startedAt = Date.now();
    // Track resources for cleanup on late failure. All must be
    // deleted in the finally-equivalent cleanup step so a mid-run
    // crash doesn't leak an ElevenLabs voice slot.
    let allocatedVoiceId: string | null = null;

    try {
      const jobUserId = assertScalarDefinedForPostgres(userId, 'userId', 'polish28:entry');

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
        await markJobFailed(jobId, jobUserId, 'Polish-28: job row not found', 0);
        return { jobId, mode, generated: 0 };
      }
      const conceptId = job.conceptIds?.[0];
      if (!conceptId) {
        const msg = 'Polish-28 requires a concept with vision-analyzed persona metadata.';
        await markJobFailed(jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }

      // ---------- Step B: mark processing + preflight BYOK ----------
      await guardedStepRun(step, 'mark-processing', async () => {
        const db = getDb();
        await db
          .update(schema.generationJobs)
          .set({ status: 'processing' })
          .where(eq(schema.generationJobs.id, jobId));
        await patchMetadata(jobId, {
          polish28_progress: { step: 'mark-processing', pct: 5, at: nowIso() },
        });
        return safeInngestStepReturn({ ok: true });
      });

      const keys = await guardedStepRun(step, 'preflight-byok', async () => {
        try {
          const loaded = await loadDecryptedKeys(jobUserId, [
            'claude',
            'gemini',
            'elevenlabs',
            'heygen',
          ]);
          if (!loaded.claude) throw new MissingProviderKeyError('claude');
          if (!loaded.gemini) throw new MissingProviderKeyError('gemini');
          if (!loaded.elevenlabs) throw new MissingProviderKeyError('elevenlabs');
          if (!loaded.heygen) throw new MissingProviderKeyError('heygen');
          return safeInngestStepReturn({
            claude: loaded.claude,
            gemini: loaded.gemini,
            elevenlabs: loaded.elevenlabs,
            heygen: loaded.heygen,
          });
        } catch (err) {
          if (err instanceof MissingProviderKeyError) {
            throw new NonRetriableError(
              `Polish-28 requires 4 BYOK keys (Claude + Gemini + ElevenLabs + HeyGen). ` +
                `Missing: ${err.message}. Connect at /settings/connections.`,
            );
          }
          throw err;
        }
      });

      // ---------- Step C: load concept + source context ----------
      const source = await guardedStepRun(step, 'load-source-context', async () => {
        const db = getDb();
        const concept = await db.query.concepts.findFirst({
          where: eq(schema.concepts.id, conceptId),
          columns: {
            metadata: true,
            ugcOriginalScript: true,
            fileUrl: true,
          },
        });
        if (!concept) {
          throw new NonRetriableError(`Polish-28: concept ${conceptId} not found.`);
        }
        const conceptMeta = (concept.metadata ?? null) as Record<string, unknown> | null;
        const analysis = (conceptMeta?.['analysis'] ?? null) as Record<string, unknown> | null;
        // Polish-28.0.2 Commit 64.2 hotfix: persona from POLISH23_VISION
        // is a STRUCTURED OBJECT { gender, age_range, ethnicity, look,
        // voice_tone } — not a string. Also handle the legacy UGC_
        // DECONSTRUCTOR shape (analysis.subject.appearance) as a
        // fallback so pre-Commit-64.1 concepts still produce a portrait
        // rather than throwing at .trim(). flattenPersonaForClonePrompt
        // normalizes both shapes to a rich description string.
        const rawPersona = analysis?.['persona'] ?? null;
        const subjectAppearance =
          (analysis?.['subject'] as { appearance?: string } | undefined)?.appearance ?? null;
        // Prefer the structured persona object; if absent, fall back to
        // subject.appearance as a raw string.
        const personaSource: unknown = rawPersona ?? subjectAppearance ?? '';
        const personaDescription = flattenPersonaForClonePrompt(personaSource);
        const cachedRef = (conceptMeta?.['polish28_character_reference'] ??
          null) as Polish28CharacterReference | null;
        return safeInngestStepReturn({
          personaDescription,
          personaRawShape: typeof rawPersona,
          ugcOriginalScript: concept.ugcOriginalScript ?? '',
          sourceVideoUrl: concept.fileUrl ?? null,
          cachedCharacterReference: cachedRef,
          conceptMeta,
        });
      });
      if (
        typeof source.personaDescription !== 'string' ||
        source.personaDescription.trim().length < 10
      ) {
        const msg =
          `Polish-28 could not extract a usable persona from concept.metadata.analysis. ` +
          `Rendered length=${source.personaDescription?.length ?? 0} raw-shape=${source.personaRawShape}. ` +
          `Expected the POLISH23_VISION structured persona object OR a non-empty subject.appearance string.`;
        await markJobFailed(jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }
      if (!source.sourceVideoUrl) {
        const msg = 'Polish-28 requires concept.file_url (source video URL).';
        await markJobFailed(jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }
      const sourceVideoUrl = source.sourceVideoUrl;

      // ---------- Step D: condense script ----------
      const condensed = await guardedStepRun(step, 'condense-script', async () => {
        const userPrompt = composePolish25CondenserUserPrompt(source.ugcOriginalScript);
        const r = await callClaude({
          userId: jobUserId,
          apiKey: keys.claude!,
          systemPrompt: POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT,
          userMessage: userPrompt,
          maxTokens: 2000,
          generationJobId: jobId,
        });
        if (!r.ok || !r.text || r.text.trim().length === 0) {
          throw new NonRetriableError(
            `Polish-28 Claude script condense failed: ${r.errorMessage ?? 'unknown'}`,
          );
        }
        const rawText = r.text.trim();
        // Same gate as Polish-26: skip nested-quote check (HeyGen tolerates)
        // + keep empty/too-long/appearance-leak enforced.
        const check = checkPolish25CondensedScript(rawText, { skipNestedQuotes: true });
        if (!check.ok) {
          throw new NonRetriableError(
            `Polish-28 condensed-script validation failed [${check.reason}]: ${check.detail}. ` +
              `Excerpt: ${JSON.stringify(rawText.slice(0, 300))}`,
          );
        }
        await patchMetadata(jobId, {
          polish28_progress: { step: 'condense-script', pct: 15, at: nowIso() },
          polish28_condensed_script: rawText,
        });
        return safeInngestStepReturn({ text: rawText, chars: rawText.length });
      });

      // ---------- Step E: extract source audio (with loop mitigation) ----------
      const sourceAudio = await guardedStepRun(step, 'extract-source-audio', async () => {
        const outcome = await extractSourceAudioLoopMitigated({
          sourceVideoUrl: sourceVideoUrl!,
        });
        if (!outcome.ok) {
          throw new NonRetriableError(
            `Polish-28 source-audio extract failed [${outcome.reason}]: ${outcome.detail}`,
          );
        }
        await patchMetadata(jobId, {
          polish28_progress: { step: 'extract-source-audio', pct: 25, at: nowIso() },
          polish28_source_audio: {
            base_duration_seconds: outcome.baseDurationSeconds,
            loop_factor: outcome.loopFactor,
            final_duration_seconds: outcome.finalDurationSeconds,
            bytes: outcome.audioBytes.byteLength,
          },
        });
        // Serializing the audio bytes through Inngest's step return
        // would be huge — instead return a base64 snapshot for the
        // next step to consume. Sizes here are ~1-2 MB for 65s @ 128kbps.
        const buf = Buffer.from(outcome.audioBytes);
        return safeInngestStepReturn({
          audioBase64: buf.toString('base64'),
          audioMimeType: outcome.audioMimeType,
          audioFilename: outcome.audioFilename,
          baseDurationSeconds: outcome.baseDurationSeconds,
          loopFactor: outcome.loopFactor,
          finalDurationSeconds: outcome.finalDurationSeconds,
        });
      });

      // ---------- Step F: clone voice ----------
      const voiceName = `${POLISH28_TEMP_VOICE_NAME_PREFIX}${jobId}_${Date.now()}`;
      const voice = await guardedStepRun(step, 'clone-voice', async () => {
        const buf = Buffer.from(sourceAudio.audioBase64, 'base64');
        const audioBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const r = await createInstantVoiceClone({
          userId: jobUserId,
          apiKey: keys.elevenlabs!,
          name: voiceName,
          audioBytes,
          audioMimeType: sourceAudio.audioMimeType,
          audioFilename: sourceAudio.audioFilename,
          description: `Polish-28 temp voice for jobId=${jobId}`,
          removeBackgroundNoise: true,
          generationJobId: jobId,
        });
        if (!r.ok || !r.voiceId) {
          throw new NonRetriableError(
            `Polish-28 voice clone failed: ${r.errorMessage ?? 'unknown'}`,
          );
        }
        await patchMetadata(jobId, {
          polish28_progress: { step: 'clone-voice', pct: 35, at: nowIso() },
          polish28_temp_voice_id: r.voiceId,
        });
        return safeInngestStepReturn({ voiceId: r.voiceId });
      });
      allocatedVoiceId = voice.voiceId;

      // ---------- Step G: clone-or-reuse character reference ----------
      const personaHash = hashPersona(source.personaDescription);
      const cached = source.cachedCharacterReference;
      const cachedIsFresh =
        cached &&
        cached.personaHash === personaHash &&
        Date.now() - new Date(cached.createdAt).getTime() < CHARACTER_REF_MAX_AGE_MS;

      const character = await guardedStepRun(step, 'clone-or-reuse-character', async () => {
        if (cachedIsFresh && cached) {
          console.log(
            `[polish28] reusing cached character reference personaHash=${personaHash} ` +
              `age=${Math.round((Date.now() - new Date(cached.createdAt).getTime()) / 1000)}s`,
          );
          return safeInngestStepReturn({
            reused: true,
            storagePath: cached.storagePath,
            publicUrl: cached.publicUrl,
            personaHash: cached.personaHash,
            costUsd: 0,
          });
        }
        // Fresh clone via Nano Banana Pro.
        // Need a reference frame from the source ad — fetch the source
        // video and extract a mid-clip frame via ffmpeg. For MVP we
        // pass the whole source video as the reference (Gemini image
        // API accepts video-first-frame from an image ref anyway) —
        // actually Nano Banana Pro requires a still image, so fetch
        // the source video's first frame via ffmpeg.
        // For a scoped MVP: just pass the source video URL AS a ref
        // frame; Gemini will use the first accessible frame when the
        // MIME suggests video. Fallback: send an already-uploaded
        // preview frame if one exists.
        //
        // Simpler + reliable: fetch source video, ffmpeg-extract the
        // first frame as PNG, base64-encode, send as reference.
        const framePng = await extractFirstFramePng(sourceVideoUrl!);
        const prompt = composeNanoBananaCharacterClonePrompt(source.personaDescription);
        const r = await cloneCharacterReferenceImage({
          userId: jobUserId,
          apiKey: keys.gemini!,
          prompt,
          referenceImageBase64: framePng.base64,
          referenceImageMimeType: 'image/png',
          generationJobId: jobId,
        });
        if (!r.ok || !r.imageBase64) {
          throw new NonRetriableError(
            `Polish-28 character clone failed: ${r.errorMessage ?? 'unknown'}. ` +
              `diagnostics=${JSON.stringify(r.diagnostics ?? {}).slice(0, 500)}`,
          );
        }
        const uploaded = await uploadGeneratedImage({
          userId: jobUserId,
          jobId,
          variantIndex: 0,
          imageBase64: r.imageBase64,
          mimeType: r.imageMimeType ?? 'image/png',
          filenamePrefix: 'polish28-character-',
        });
        // Persist to concept metadata for future reuse.
        const db = getDb();
        const concept = await db.query.concepts.findFirst({
          where: eq(schema.concepts.id, conceptId),
          columns: { metadata: true },
        });
        const conceptMeta = (concept?.metadata ?? {}) as Record<string, unknown>;
        const refPayload: Polish28CharacterReference = {
          storagePath: uploaded.path,
          publicUrl: uploaded.publicUrl,
          personaHash,
          createdAt: nowIso(),
          modelIdUsed: r.diagnostics?.modelId ?? 'gemini-3-pro-image-preview',
        };
        const updatedMeta = assertNoUndefinedForPostgres(
          { ...conceptMeta, polish28_character_reference: refPayload },
          'polish28:persist-character-reference',
        );
        await db
          .update(schema.concepts)
          .set({ metadata: updatedMeta })
          .where(eq(schema.concepts.id, conceptId));
        await patchMetadata(jobId, {
          polish28_progress: { step: 'clone-character', pct: 50, at: nowIso() },
          polish28_character_ref_generated: true,
          polish28_character_cost_usd: r.costUsd,
        });
        return safeInngestStepReturn({
          reused: false,
          storagePath: uploaded.path,
          publicUrl: uploaded.publicUrl,
          personaHash,
          costUsd: r.costUsd,
        });
      });

      // ---------- Step H: TTS with cloned voice ----------
      const tts = await guardedStepRun(step, 'tts-with-cloned-voice', async () => {
        const r = await submitElevenLabsTts({
          userId: jobUserId,
          apiKey: keys.elevenlabs!,
          voiceId: voice.voiceId,
          text: condensed.text,
          generationJobId: jobId,
        });
        if (!r.ok || !r.audio) {
          throw new NonRetriableError(`Polish-28 TTS failed: ${r.errorMessage ?? 'unknown'}`);
        }
        const buf = Buffer.from(r.audio);
        const uploaded = await uploadGeneratedAudio({
          userId: jobUserId,
          jobId,
          audioBase64: buf.toString('base64'),
          mimeType: 'audio/mpeg',
          filename: 'polish28-voice',
        });
        await patchMetadata(jobId, {
          polish28_progress: { step: 'tts', pct: 60, at: nowIso() },
          polish28_voice_audio: { path: uploaded.path, url: uploaded.publicUrl },
        });
        return safeInngestStepReturn({
          audioUrl: uploaded.publicUrl,
          audioPath: uploaded.path,
          audioBytes: r.audio.byteLength,
        });
      });

      // ---------- Step I: upload character image to HeyGen ----------
      const heygenAsset = await guardedStepRun(step, 'upload-heygen-image-asset', async () => {
        // Fetch character image bytes from Supabase (public URL).
        const fetchRes = await fetch(character.publicUrl);
        if (!fetchRes.ok) {
          throw new NonRetriableError(
            `Polish-28 could not fetch character image for HeyGen upload (HTTP ${fetchRes.status}).`,
          );
        }
        const arr = await fetchRes.arrayBuffer();
        const bytes = new Uint8Array(arr);
        const r = await uploadHeygenImageAsset({
          userId: jobUserId,
          apiKey: keys.heygen!,
          imageBytes: bytes,
          imageMimeType: 'image/png',
          generationJobId: jobId,
        });
        if (!r.ok || !r.imageKey) {
          throw new NonRetriableError(
            `Polish-28 HeyGen upload-asset failed [${r.errorCategory ?? 'unknown'}]: ` +
              `${r.errorMessage ?? 'unknown'}`,
          );
        }
        await patchMetadata(jobId, {
          polish28_progress: { step: 'upload-heygen-asset', pct: 70, at: nowIso() },
          polish28_heygen_image_key: r.imageKey,
        });
        return safeInngestStepReturn({ imageKey: r.imageKey });
      });

      // ---------- Step J: submit HeyGen Avatar IV generation ----------
      const heygenSubmit = await guardedStepRun(step, 'submit-heygen-avatar-iv', async () => {
        const r = await submitHeygenAvatarIvGeneration({
          userId: jobUserId,
          apiKey: keys.heygen!,
          imageKey: heygenAsset.imageKey,
          audioUrl: tts.audioUrl,
          videoTitle: `polish28_${jobId}`,
          generationJobId: jobId,
        });
        if (!r.ok || !r.videoId) {
          throw new NonRetriableError(
            `Polish-28 HeyGen Avatar IV submit failed [${r.errorCategory ?? 'unknown'}]: ` +
              `${r.errorMessage ?? 'unknown'}`,
          );
        }
        await patchMetadata(jobId, {
          polish28_progress: { step: 'submit-heygen', pct: 75, at: nowIso() },
          polish28_heygen_video_id: r.videoId,
          polish28_aspect_ratio: POLISH28_ASPECT_RATIO,
        });
        return safeInngestStepReturn({ videoId: r.videoId });
      });

      // ---------- Step K: poll HeyGen status (chunked) ----------
      let finalVideoUrl: string | null = null;
      let finalDurationSeconds: number | null = null;
      for (let attempt = 0; attempt < HEYGEN_POLL_MAX_ATTEMPTS; attempt++) {
        const pollResult = await guardedStepRun(step, `poll-heygen-status-${attempt}`, async () => {
          const r = await checkHeygenAvatarIvStatus({
            userId: jobUserId,
            apiKey: keys.heygen!,
            videoId: heygenSubmit.videoId,
            generationJobId: jobId,
          });
          return safeInngestStepReturn({
            ok: r.ok,
            status: r.status,
            videoUrl: r.videoUrl ?? null,
            durationSeconds: r.durationSeconds ?? null,
            errorMessage: r.errorMessage ?? null,
          });
        });
        if (!pollResult.ok || pollResult.status === 'failed') {
          const msg =
            `Polish-28 HeyGen Avatar IV failed after ${attempt + 1} polls: ` +
            `${pollResult.errorMessage ?? 'unknown'}`;
          throw new NonRetriableError(msg);
        }
        if (pollResult.status === 'completed' && pollResult.videoUrl) {
          finalVideoUrl = pollResult.videoUrl;
          finalDurationSeconds = pollResult.durationSeconds;
          break;
        }
        if (isTerminalAvatarIvStatus(pollResult.status)) break;
        // Not terminal — sleep + retry.
        await step.sleep(`poll-wait-${attempt}`, `${HEYGEN_POLL_INTERVAL_SECONDS}s`);
      }
      if (!finalVideoUrl) {
        throw new NonRetriableError(
          `Polish-28 HeyGen Avatar IV timed out after ${HEYGEN_POLL_MAX_ATTEMPTS} polls ` +
            `(${HEYGEN_POLL_MAX_ATTEMPTS * HEYGEN_POLL_INTERVAL_SECONDS}s).`,
        );
      }

      // ---------- Step L: upload final video to Supabase ----------
      const uploaded = await guardedStepRun(step, 'upload-final-video', async () => {
        const r = await uploadGeneratedVideoFromUrl({
          userId: jobUserId,
          jobId,
          remoteUrl: finalVideoUrl!,
          filename: 'polish28-lipsync',
          compress: true,
        });
        await patchMetadata(jobId, {
          polish28_progress: { step: 'upload-final', pct: 90, at: nowIso() },
          polish28_final_video: { path: r.path, url: r.publicUrl, bytes: r.sizeBytes },
        });
        return safeInngestStepReturn({
          path: r.path,
          publicUrl: r.publicUrl,
          sizeBytes: r.sizeBytes,
        });
      });

      // ---------- Step M: persist creative ----------
      await guardedStepRun(step, 'persist-creative', async () => {
        const db = getDb();
        const heygenCost = estimateHeygenAvatarIvCostUsd(finalDurationSeconds ?? 30);
        const totalCost = heygenCost + (character.costUsd ?? 0) + 0.03;
        const creativeRecord = assertNoUndefinedForPostgres(
          {
            userId: jobUserId,
            generationJobId: jobId,
            fileUrl: uploaded.publicUrl,
            imageStoragePath: uploaded.path,
            hookVariantIndex: 0,
            bodyVariantIndex: 0,
            ctaVariantIndex: 0,
            aspectRatio: '9:16' as const,
          },
          'polish28:generated-creatives-insert',
        );
        await db
          .insert(schema.generatedCreatives)
          .values(creativeRecord as typeof schema.generatedCreatives.$inferInsert);
        return safeInngestStepReturn({ totalCostUsd: totalCost });
      });

      // ---------- Step N: cleanup temp voice ----------
      await guardedStepRun(step, 'cleanup-temp-voice', async () => {
        if (!allocatedVoiceId) return safeInngestStepReturn({ skipped: true });
        const r = await deleteElevenLabsVoice({
          userId: jobUserId,
          apiKey: keys.elevenlabs!,
          voiceId: allocatedVoiceId,
          generationJobId: jobId,
        });
        return safeInngestStepReturn({
          deleted: r.ok,
          voiceId: allocatedVoiceId,
          errorMessage: r.errorMessage ?? null,
        });
      });

      // ---------- Step O: mark completed ----------
      const heygenCost = estimateHeygenAvatarIvCostUsd(finalDurationSeconds ?? 30);
      const totalCost = heygenCost + (character.costUsd ?? 0) + 0.03;
      await markJobCompleted({
        jobId,
        userId: jobUserId,
        mode,
        startedAt,
        variantCount: 1,
        actualCostUsd: totalCost,
        provider: 'clone_ugc',
        path: 'ugc',
      });
      await patchMetadata(jobId, {
        polish28_progress: { step: 'completed', pct: 100, at: nowIso() },
      });
      return { jobId, mode, generated: 1, finalVideoUrl: uploaded.publicUrl };
    } catch (err) {
      // Best-effort orphan-voice cleanup on error path so the slot
      // is freed before Inngest re-raises. Daily reaper backstops this.
      if (allocatedVoiceId) {
        try {
          const keysForCleanup = await loadDecryptedKeys(userId, ['elevenlabs']);
          if (keysForCleanup.elevenlabs) {
            await deleteElevenLabsVoice({
              userId,
              apiKey: keysForCleanup.elevenlabs,
              voiceId: allocatedVoiceId,
              generationJobId: jobId,
            });
            console.log(`[polish28] cleaned up orphan voice ${allocatedVoiceId} on error path`);
          }
        } catch (cleanupErr) {
          console.error(
            `[polish28] orphan voice cleanup failed for ${allocatedVoiceId}:`,
            cleanupErr,
          );
        }
      }
      rethrowWithUndefinedContext(err, 'generatePolish28CloneUgc');
    }
  },
);

/**
 * Extract the first frame of a video URL as PNG bytes via ffmpeg.
 * Used by Step G to hand a still-image reference to Nano Banana Pro
 * (which requires an image, not a video).
 */
async function extractFirstFramePng(videoUrl: string): Promise<{ base64: string }> {
  const { resolveFfmpegPath } = await import('../lib/video-compress');
  const workDir = await mkdtemp(join(tmpdir(), 'polish28-frame-'));
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`fetch source-video HTTP ${res.status}`);
    const srcBuf = Buffer.from(await res.arrayBuffer());
    const srcPath = join(workDir, 'source.mp4');
    const outPath = join(workDir, 'frame.png');
    await writeFile(srcPath, srcBuf);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        resolveFfmpegPath(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          '00:00:01',
          '-i',
          srcPath,
          '-frames:v',
          '1',
          '-y',
          outPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      const errChunks: Buffer[] = [];
      child.stderr?.on('data', (c: Buffer) => errChunks.push(c));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `ffmpeg frame-extract exited ${code}: ${Buffer.concat(errChunks).toString('utf8').slice(0, 400)}`,
            ),
          );
      });
    });

    const pngBuf = await readFile(outPath);
    return { base64: pngBuf.toString('base64') };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
