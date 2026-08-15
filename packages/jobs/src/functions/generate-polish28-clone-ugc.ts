/**
 * Polish-28.1.0 Commit 65: BYOK-only cloned-CHARACTER + matched-voice
 * UGC pipeline worker. Face is CLONED via Nano Banana Pro from a
 * source-ad frame; voice is MATCHED from a curated public ElevenLabs
 * roster based on the persona description.
 *
 * Pivoted from Polish-28.0.x's Instant-Voice-Clone (IVC) approach
 * because IVC hit hard walls: (1) requires ElevenLabs Starter+ tier
 * (Free users blocked at clone step), (2) triggers "probation mode"
 * on rapid-clone patterns, (3) 10-voice cap on Starter → filled up
 * in a day of testing, (4) eventual-consistency lag between clone
 * and TTS caused spurious 401s. Public voices from the roster work
 * on every ElevenLabs tier including Free, have no cap, no cleanup,
 * and are always queryable for TTS immediately.
 *
 * Trade-off: matched voice ≈ source voice (similar gender/age/timbre)
 * but not identical. For UGC ad variations this is acceptable —
 * the visual character clone carries the identity load.
 *
 * Steps (each its own guardedStepRun for per-step try/catch + logging):
 *   A. load-job                  fetch generation_jobs + concept
 *   B. mark-processing           update status + progress
 *   C. load-source-context       persona + source video URL from concepts
 *   D. condense-script           Claude → 30s-target UGC monologue
 *   E. match-voice-for-persona   pick from ELEVENLABS_VOICE_ROSTER
 *                                based on gender+age keywords in persona
 *   F. prepare-source-frame      Polish-28.1.3: extract source-ad frame
 *                                via fofr/toolkit + jimp downscale (was
 *                                Nano Banana Pro clone in 28.1.2 — pivoted
 *                                for UGC realism, see Commit 68 header)
 *   G. tts-with-matched-voice    ElevenLabs TTS → mp3 bytes → Supabase URL
 *   H. upload-heygen-image-asset upload character image bytes → image_key
 *   I. submit-heygen-avatar-iv   image_key + audio_url → video_id
 *   J. poll-heygen-status        chunked 1-shot-per-step polls
 *   K. upload-final-video        download from HeyGen → Supabase → publicUrl
 *   L. persist-creative          insert generated_creatives row
 *
 * REMOVED vs Polish-28.0.x: extract-source-audio (was IVC input),
 * clone-voice (IVC), verify-voice-ready (IVC race workaround),
 * cleanup-temp-voice (IVC housekeeping). Also drops the ≥60s source
 * ad requirement (IVC's minimum-duration constraint).
 *
 * BYOK requirement: 5 keys (Claude, Gemini, ElevenLabs, HeyGen,
 * Replicate). Replicate still needed for the first-frame extract
 * feeding Nano Banana Pro character reference. The generate form
 * gates on this upstream; the worker double-checks in load-keys.
 *
 * Output: 9:16 vertical video (locked per Polish-28 spec — no user
 * choice). HeyGen Avatar IV supports 9:16 or 16:9 only; 9:16 wins
 * for Meta Reels / TikTok / IG Reels affiliate creatives.
 */
import { Buffer } from 'node:buffer';
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  estimateHeygenAvatarIvCostUsd,
  flattenPersonaForClonePrompt,
  isTerminalAvatarIvStatus,
  POLISH28_ASPECT_RATIO,
  submitElevenLabsTts,
  submitHeygenAvatarIvGeneration,
  checkHeygenAvatarIvStatus,
  uploadHeygenImageAsset,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { matchElevenLabsVoiceForPersona, POLISH_VERSION } from '@mbb/shared';
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

// Polish-28.1.6 Commit 71: 30x10s=300s (5min) ceiling was too tight
// for HeyGen Avatar IV image-to-video which routinely takes 5-15
// min end-to-end. 28.1.5 first-credited-run timed out mid-generation.
// Bumped to 90x15s=1350s (~22 min) — covers p99 completion time
// while capping the total spend at a reasonable ceiling for a
// stuck HeyGen job.
const HEYGEN_POLL_MAX_ATTEMPTS = 90;
const HEYGEN_POLL_INTERVAL_SECONDS = 15;

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
          // Polish-28.0.5 Commit 64.5: added `replicate` — Vercel Hobby
          // can't host the ffmpeg binary (~78MB > 50MB function limit)
          // so audio + frame extraction pivots to Replicate ffmpeg.
          // 5-BYOK requirement.
          const loaded = await loadDecryptedKeys(jobUserId, [
            'claude',
            'gemini',
            'elevenlabs',
            'heygen',
            'kling',
          ]);
          if (!loaded.claude) throw new MissingProviderKeyError('claude');
          if (!loaded.gemini) throw new MissingProviderKeyError('gemini');
          if (!loaded.elevenlabs) throw new MissingProviderKeyError('elevenlabs');
          if (!loaded.heygen) throw new MissingProviderKeyError('heygen');
          if (!loaded.kling) throw new MissingProviderKeyError('kling');
          return safeInngestStepReturn({
            claude: loaded.claude,
            gemini: loaded.gemini,
            elevenlabs: loaded.elevenlabs,
            heygen: loaded.heygen,
            // Stored under 'kling' DecryptedKeys slot but sourced from
            // the Replicate ai_provider_connections row (see load-keys.ts
            // fetchCiphertext's kling→replicate fallback).
            kling: loaded.kling,
          });
        } catch (err) {
          if (err instanceof MissingProviderKeyError) {
            throw new NonRetriableError(
              `Polish-28 requires 5 BYOK keys (Claude + Gemini + ElevenLabs + HeyGen + Replicate). ` +
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
        // Polish-28.1.5 Commit 70 hotfix: pass the FULL vision analysis
        // JSON to the condenser (matching Polish-25's pattern), not the
        // raw ugcOriginalScript. The condenser prompt expects
        // "source-video vision analysis (JSON with transcript + persona
        // + emotional_arc + hook_structure + niche_category)" — feeding
        // it just an empty raw script string produced literal "no
        // transcript" refusals from Claude, which TTS then spoke aloud
        // (28.1.4 output: 19s of voiceover saying "no transcript").
        const visionAnalysisJson = analysis ? JSON.stringify(analysis, null, 2) : null;
        return safeInngestStepReturn({
          personaDescription,
          personaRawShape: typeof rawPersona,
          ugcOriginalScript: concept.ugcOriginalScript ?? '',
          visionAnalysisJson,
          // Polish-28.0.3 Commit 64.3 hotfix: concept.file_url is a
          // Supabase-storage RELATIVE PATH (not an https URL). Passing
          // that string to fetch() throws "Failed to parse URL from".
          // Downstream steps (extract-source-audio, extractFirstFramePng)
          // now consume this as a storage-tuple ({bucket:'concepts', path}).
          sourceStoragePath: concept.fileUrl ?? null,
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
      if (!source.sourceStoragePath) {
        const msg =
          'Polish-28 requires concept.file_url (source video storage path). ' +
          'Re-upload the source ad and retry.';
        await markJobFailed(jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }
      const sourceStoragePath = source.sourceStoragePath;
      /** Bucket name matches analyze-concept.ts + generate-static-*.ts. */
      const SOURCE_BUCKET = 'concepts';

      // ---------- Step D: condense script ----------
      // Polish-28.1.5 Commit 70: feed the FULL vision-analysis JSON
      // (transcript + persona + hook + emotional arc + niche) not just
      // the bare ugcOriginalScript. See load-source-context step's
      // visionAnalysisJson field for the pattern rationale.
      const condensed = await guardedStepRun(step, 'condense-script', async () => {
        // Preflight: refuse to call Claude if we have neither
        // vision-analysis JSON nor a meaningful raw script. Without
        // input Claude returns literal "no transcript" refusals
        // (28.1.4 death). Better to fail fast with a directional
        // error than TTS-speak the refusal.
        const rawInput =
          source.visionAnalysisJson ??
          (source.ugcOriginalScript && source.ugcOriginalScript.trim().length >= 20
            ? source.ugcOriginalScript
            : null);
        if (!rawInput) {
          throw new NonRetriableError(
            `Polish-28 condense-script has no usable input: concept ${conceptId} has neither ` +
              `metadata.analysis (Gemini vision output) nor ugcOriginalScript >=20 chars. ` +
              `Re-run analyze-concept on this concept before submitting Polish-28.`,
          );
        }
        const userPrompt = composePolish25CondenserUserPrompt(rawInput);
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
        // Polish-28.1.5 refusal guard: reject Claude outputs that are
        // clearly meta-commentary ("no transcript", "cannot condense",
        // "no analysis provided") rather than a real UGC monologue.
        // 28.1.4 output was 19s of TTS saying "no transcript" because
        // Claude was given an empty input and politely refused; we then
        // TTS'd the refusal.
        if (isCondenserRefusalOutput(rawText)) {
          throw new NonRetriableError(
            `Polish-28 Claude condense output looks like a refusal (${JSON.stringify(rawText.slice(0, 200))}). ` +
              `Input was ${rawInput.length} chars. Concept may lack usable vision analysis — ` +
              `re-run analyze-concept.`,
          );
        }
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

      // ---------- Step E: match voice for persona ----------
      // Polish-28.1.0 Commit 65 pivot: no more IVC. Match against the
      // curated ELEVENLABS_VOICE_ROSTER (5 public preset voices,
      // work on every ElevenLabs tier). Keyword-scan the flattened
      // persona for gender + age markers → best-fit roster entry.
      const voice = await guardedStepRun(step, 'match-voice-for-persona', async () => {
        const matched = matchElevenLabsVoiceForPersona(source.personaDescription);
        await patchMetadata(jobId, {
          polish28_progress: { step: 'match-voice', pct: 30, at: nowIso() },
          polish28_matched_voice: {
            voice_id: matched.id,
            label: matched.label,
            gender: matched.gender,
            age: matched.age,
          },
        });
        return safeInngestStepReturn({
          voiceId: matched.id,
          label: matched.label,
        });
      });

      // ---------- Step F: prepare source frame for HeyGen ----------
      // Polish-28.1.3 Commit 68: skip Nano Banana Pro character clone
      // ENTIRELY. Feed HeyGen Avatar IV the ACTUAL source-ad frame —
      // real person, real background, real lighting. HeyGen explicitly
      // supports "any photo" for Avatar IV.
      //
      // Why: 28.1.2 shipped a green pipeline but the Nano Banana Pro
      // output was studio-portrait aesthetic (clean white bg, slightly
      // stylized) — HeyGen then faithfully lip-synced that stylized
      // image, giving non-UGC-realistic output. The pipeline was
      // technically correct but the value prop was broken.
      //
      // Trade-offs of this pivot:
      //   + Real UGC realism (source ad's actual face + bg)
      //   + Perfect character consistency (same frame every gen from
      //     same concept — was best-effort with Nano Banana cache)
      //   + Removes a $0.13/gen Nano Banana call (whole pipeline cost
      //     drops by that much)
      //   + Removes Gemini image-gen dependency from the polish28 hot
      //     path (Gemini vision still needed upstream in analyze-concept
      //     for persona extraction — 5-BYOK gate unchanged)
      //   - No visual variation across generations from same concept —
      //     the person always looks identical because it IS identical.
      //     Fine for A/B variant testing on script + voice only.
      const sourceFrame = await guardedStepRun(step, 'prepare-source-frame', async () => {
        const frame = await extractFirstFramePng({
          storageBucket: SOURCE_BUCKET,
          storagePath: sourceStoragePath,
          userId: jobUserId,
          replicateApiKey: keys.kling,
          generationJobId: jobId,
        });
        // Persist so we have a Supabase URL for the composite record +
        // operator debug + downstream HeyGen upload can fetch it.
        const uploaded = await uploadGeneratedImage({
          userId: jobUserId,
          jobId,
          variantIndex: 0,
          imageBase64: frame.base64,
          mimeType: frame.mimeType,
          filenamePrefix: 'polish28-sourceframe-',
        });
        await patchMetadata(jobId, {
          polish28_progress: { step: 'prepare-source-frame', pct: 50, at: nowIso() },
          polish28_source_frame: {
            path: uploaded.path,
            url: uploaded.publicUrl,
            mime: frame.mimeType,
          },
        });
        return safeInngestStepReturn({
          publicUrl: uploaded.publicUrl,
          storagePath: uploaded.path,
          mimeType: frame.mimeType,
          costUsd: 0, // No Nano Banana call — just frame extract cost bundled in Replicate
        });
      });

      // ---------- Step G: TTS with matched voice ----------
      // Polish-28.1.0 pivot: no more verify-voice-ready poll —
      // public preset voices are always queryable, no eventual-consistency
      // race like fresh IVC clones had (Polish-28.0.13's failure mode).
      const tts = await guardedStepRun(step, 'tts-with-matched-voice', async () => {
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

      // ---------- Step I: upload source frame to HeyGen ----------
      // Polish-28.1.3: fetches sourceFrame (real source-ad frame) not
      // the deleted Nano Banana character clone.
      const heygenAsset = await guardedStepRun(step, 'upload-heygen-image-asset', async () => {
        const fetchRes = await fetch(sourceFrame.publicUrl);
        if (!fetchRes.ok) {
          throw new NonRetriableError(
            `Polish-28 could not fetch source frame for HeyGen upload (HTTP ${fetchRes.status}).`,
          );
        }
        const arr = await fetchRes.arrayBuffer();
        const bytes = new Uint8Array(arr);
        // Polish-28.1.2 Commit 67 hotfix: detect actual MIME from
        // magic bytes instead of hardcoding image/png. Nano Banana
        // Pro can return either PNG or JPEG depending on the model
        // version + prompt — 28.1.1 died with HeyGen 400 "Content
        // type not match image/png != image/jpeg" when the character
        // clone came back as JPEG. HeyGen validates the declared
        // content-type against the actual bytes and rejects on
        // mismatch. Sniff and trust the bytes.
        const detectedMime: 'image/png' | 'image/jpeg' | 'image/webp' =
          bytes.length >= 4 &&
          bytes[0] === 0x89 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x4e &&
          bytes[3] === 0x47
            ? 'image/png'
            : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
              ? 'image/jpeg'
              : bytes.length >= 12 &&
                  bytes[0] === 0x52 &&
                  bytes[1] === 0x49 &&
                  bytes[2] === 0x46 &&
                  bytes[3] === 0x46 &&
                  bytes[8] === 0x57 &&
                  bytes[9] === 0x45 &&
                  bytes[10] === 0x42 &&
                  bytes[11] === 0x50
                ? 'image/webp'
                : 'image/png'; // Defensive fallback — HeyGen will reject if wrong, cheaper than throwing here.
        const r = await uploadHeygenImageAsset({
          userId: jobUserId,
          apiKey: keys.heygen!,
          imageBytes: bytes,
          imageMimeType: detectedMime,
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
        const totalCost = heygenCost + (sourceFrame.costUsd ?? 0) + 0.03;
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

      // ---------- Step L': mark completed ----------
      // Polish-28.1.0 pivot: no cleanup-temp-voice step — matched
      // voices are public presets, nothing to clean up.
      const heygenCost = estimateHeygenAvatarIvCostUsd(finalDurationSeconds ?? 30);
      const totalCost = heygenCost + (sourceFrame.costUsd ?? 0) + 0.03;
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
      // Polish-28.1.0 pivot: no orphan-voice cleanup — matched voices
      // are public presets, nothing to leak on the error path.
      rethrowWithUndefinedContext(err, 'generatePolish28CloneUgc');
    }
  },
);

/**
 * Extract the first frame of a source video as PNG bytes.
 *
 * Polish-28.0.5 Commit 64.5: switched from local ffmpeg spawn to
 * Replicate ffmpeg (same reason as extract-source-audio — the local
 * @ffmpeg-installer binary blew Vercel Hobby's 50MB function limit
 * in 28.0.4). Signed-URL → Replicate submit → poll → download PNG.
 */
async function extractFirstFramePng(input: {
  storageBucket: string;
  storagePath: string;
  userId: string;
  replicateApiKey: string;
  generationJobId?: string;
}): Promise<{ base64: string; mimeType: 'image/jpeg' }> {
  const { getServiceRoleSupabase } = await import('../lib/storage');
  const { callProvider } = await import('@mbb/ai-providers');
  const { getPolish28FfmpegModelId } = await import('../lib/extract-source-audio');

  const modelRaw = getPolish28FfmpegModelId();
  if (!modelRaw) {
    throw new Error(
      'POLISH28_REPLICATE_FFMPEG_MODEL_ID unset — Polish-28 frame-extract needs a Replicate ffmpeg model. See extract-source-audio.ts docs.',
    );
  }

  // Sign the source URL for Replicate.
  const supabase = getServiceRoleSupabase();
  const { data: signed, error: signErr } = await supabase.storage
    .from(input.storageBucket)
    .createSignedUrl(input.storagePath, 60 * 60);
  if (signErr || !signed?.signedUrl) {
    throw new Error(
      `Polish-28 frame-extract signed-URL failed for ${input.storageBucket}/${input.storagePath}: ${signErr?.message ?? 'no signedUrl'}`,
    );
  }
  const sourceUrl = signed.signedUrl;

  // Polish-28.0.10 Commit 64.10 hotfix: fofr/toolkit (the 28.0.9
  // default) is a task-based wrapper, not a generic-args wrapper.
  // The generic ffmpeg args shape from 28.0.5 (which worked with the
  // never-existed cuuupid/cog-ffmpeg default) gets silently ignored
  // by fofr/toolkit + submit 422s.
  //
  // fofr/toolkit's `extract_frames_from_input` task returns a list of
  // frame file URLs (List[Path]). At fps=1 we get one frame per second
  // of source — take output[0] as the first frame. Overshoot on frame
  // count is harmless: fofr charges by pod-second, not per-frame; a
  // 60s ad at fps=1 finishes in single-digit seconds.
  //
  // The `input_file` + `task` fields are fofr's schema. The other
  // legacy field names are preserved as a defensive shotgun for
  // operators who override POLISH28_REPLICATE_FFMPEG_MODEL_ID with a
  // generic-args wrapper (which will use `video`/`command` and ignore
  // `task`).
  const ffmpegArgs = '-i INPUT -ss 00:00:01 -frames:v 1 -y OUTPUT';
  const colonIdx = modelRaw.indexOf(':');
  const modelPath = colonIdx === -1 ? modelRaw : modelRaw.slice(0, colonIdx);
  const version = colonIdx === -1 ? '' : modelRaw.slice(colonIdx + 1).trim();
  const inputFields = {
    // fofr/toolkit shape:
    task: 'extract_frames_from_input',
    input_file: sourceUrl,
    fps: 1,
    // Generic ffmpeg wrapper shapes (ignored by fofr/toolkit):
    video: sourceUrl,
    video_url: sourceUrl,
    video_file: sourceUrl,
    input: sourceUrl,
    input_video: sourceUrl,
    command: ffmpegArgs,
    args: ffmpegArgs,
    ffmpeg_args: ffmpegArgs,
    filter: ffmpegArgs,
  };
  // Polish-28.0.8 Commit 64.8: Replicate's /v1/predictions REQUIRES
  // a version SHA — see extract-source-audio.ts submit block for the
  // detailed rationale. Auto-resolve latest_version.id via GET
  // /v1/models/{owner}/{name} when the slug has no explicit :sha.
  let resolvedVersion = version;
  if (!resolvedVersion) {
    const resolveResult = await callProvider<{ latest_version?: { id?: string } }>({
      userId: input.userId,
      provider: 'kling' as const,
      url: `https://api.replicate.com/v1/models/${modelPath}`,
      method: 'GET',
      headers: { Authorization: `Token ${input.replicateApiKey}` },
      timeoutMs: 15_000,
      requestBodyForLog: { polish28_frame_extract_resolve_version: true, model: modelPath },
      ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
    });
    if (!resolveResult.ok || !resolveResult.data.latest_version?.id) {
      throw new Error(
        `Polish-28 frame-extract Replicate version-resolve failed for ${modelPath}: HTTP ${resolveResult.status}. ` +
          `Response: ${JSON.stringify(resolveResult.ok ? resolveResult.data : (resolveResult.rawBody ?? {})).slice(0, 400)}`,
      );
    }
    resolvedVersion = resolveResult.data.latest_version.id;
  }
  const submitUrl = 'https://api.replicate.com/v1/predictions';
  const submitBody = { version: resolvedVersion, input: inputFields };

  const submitResult = await callProvider<{ id?: string; error?: string }>({
    userId: input.userId,
    provider: 'kling' as const,
    url: submitUrl,
    method: 'POST',
    headers: {
      Authorization: `Token ${input.replicateApiKey}`,
      'content-type': 'application/json',
    },
    body: submitBody,
    timeoutMs: 30_000,
    requestBodyForLog: { polish28_frame_extract: true, model: modelPath },
    ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
  });
  if (!submitResult.ok) {
    throw new Error(
      `Polish-28 frame-extract Replicate submit failed: ${submitResult.errorMessage}`,
    );
  }
  if (!submitResult.data.id) {
    throw new Error('Polish-28 frame-extract Replicate submit returned no prediction id');
  }
  const predictionId = submitResult.data.id;

  // Poll.
  let outputUrl: string | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const check = await callProvider<{ status?: string; output?: unknown; error?: string }>({
      userId: input.userId,
      provider: 'kling' as const,
      url: `https://api.replicate.com/v1/predictions/${encodeURIComponent(predictionId)}`,
      method: 'GET',
      headers: { Authorization: `Token ${input.replicateApiKey}` },
      timeoutMs: 15_000,
      ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
    });
    if (!check.ok) continue;
    const status = check.data.status ?? '';
    if (status === 'failed' || status === 'canceled') {
      throw new Error(
        `Polish-28 frame-extract Replicate ${status}: ${check.data.error ?? 'unknown'}`,
      );
    }
    if (status === 'succeeded') {
      const out = check.data.output;
      if (typeof out === 'string' && out.startsWith('http')) outputUrl = out;
      else if (Array.isArray(out)) {
        for (const item of out)
          if (typeof item === 'string' && item.startsWith('http')) {
            outputUrl = item;
            break;
          }
      } else if (out && typeof out === 'object') {
        const obj = out as { image?: string; frame?: string };
        outputUrl = obj.image ?? obj.frame ?? null;
      }
      break;
    }
  }
  if (!outputUrl) {
    throw new Error('Polish-28 frame-extract Replicate timed out or returned no output URL');
  }

  // Download.
  const res = await fetch(outputUrl);
  if (!res.ok) throw new Error(`Polish-28 frame-extract download HTTP ${res.status}`);
  const rawBuf = Buffer.from(await res.arrayBuffer());

  // Polish-28.0.12 Commit 64.12 hotfix: fofr/toolkit's
  // extract_frames_from_input returns a ZIP bundling all frames as
  // individual files (verified in prod at 28.0.11: jimp threw
  // "Mime type application/zip does not support decoding"). Detect
  // via PK\x03\x04 magic bytes + unzip in-memory + take the first
  // .png/.jpg entry. Operator-overridden ffmpeg models that return
  // a single image URL still work (else-branch).
  //
  // adm-zip is pure-JS with a synchronous buffer API — same
  // rationale as jimp: no native binary, no Vercel bundling risk.
  let imageBytes: Buffer;
  const isZip =
    rawBuf.length >= 4 &&
    rawBuf[0] === 0x50 &&
    rawBuf[1] === 0x4b &&
    rawBuf[2] === 0x03 &&
    rawBuf[3] === 0x04;
  if (isZip) {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(rawBuf);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    // Sort by entry name — fofr/toolkit names frames sequentially
    // (frame_00001.png, frame_00002.png, ...), so alphabetical sort
    // puts the first-extracted frame at index 0.
    entries.sort((a, b) => a.entryName.localeCompare(b.entryName));
    const firstImage = entries.find((e) => /\.(png|jpe?g)$/i.test(e.entryName));
    if (!firstImage) {
      throw new Error(
        `Polish-28 frame-extract zip contained no image entries (found ${entries.length} entries: ${entries
          .slice(0, 5)
          .map((e) => e.entryName)
          .join(', ')})`,
      );
    }
    imageBytes = firstImage.getData();
  } else {
    imageBytes = rawBuf;
  }

  // Polish-28.0.11 Commit 64.11: downscale before base64 (was for
  // Gemini's 20MB inline_data cap; still relevant for HeyGen upload
  // size + speed). jimp = pure-JS, no native binary.
  //
  // Polish-28.1.4 Commit 69: BEFORE downscale, crop out the top 10%
  // and bottom 25% of the source frame. Most UGC / affiliate source
  // ads have burned-in captions at the bottom (TikTok / Reels style)
  // and title cards / logos at the top. HeyGen faithfully preserves
  // whatever it's given, so an uncropped frame produces a lip-synced
  // video with the source ad's captions still overlaid — visible
  // artifact operator flagged in 28.1.3.
  //
  // Middle 65% keeps the face for center-framed and top-framed
  // subjects; may crop off subjects framed near the bottom of the
  // shot. Acceptable default for UGC-style pieces where the person
  // is centered. Env-tunable via POLISH28_FRAME_CROP_TOP_PCT and
  // POLISH28_FRAME_CROP_BOTTOM_PCT (each 0-45; sum <90) so a user
  // with unusual composition can bypass.
  const cropTopPct = clampCropPct(Number(process.env['POLISH28_FRAME_CROP_TOP_PCT']), 10);
  const cropBottomPct = clampCropPct(Number(process.env['POLISH28_FRAME_CROP_BOTTOM_PCT']), 25);
  const { Jimp } = await import('jimp');
  const image = await Jimp.read(imageBytes);
  const originalW = image.bitmap.width;
  const originalH = image.bitmap.height;
  const cropTopPx = Math.floor((originalH * cropTopPct) / 100);
  const cropBottomPx = Math.floor((originalH * cropBottomPct) / 100);
  const cropH = Math.max(1, originalH - cropTopPx - cropBottomPx);
  image.crop({ x: 0, y: cropTopPx, w: originalW, h: cropH });
  console.log(
    `[polish28] frame-crop: ${originalW}x${originalH} -> ${originalW}x${cropH} ` +
      `(top ${cropTopPct}%=${cropTopPx}px, bottom ${cropBottomPct}%=${cropBottomPx}px)`,
  );
  image.scaleToFit({ w: 1024, h: 1024 });
  const jpegBuf = await image.getBuffer('image/jpeg', { quality: 85 });
  return { base64: jpegBuf.toString('base64'), mimeType: 'image/jpeg' };
}

function clampCropPct(raw: number, fallback: number): number {
  if (!Number.isFinite(raw) || raw < 0 || raw >= 45) return fallback;
  return raw;
}

/**
 * Polish-28.1.5 Commit 70: heuristic detector for Claude "I can't
 * condense empty input" refusals. Short (< 200 chars) outputs that
 * contain any of these markers are almost certainly meta-commentary,
 * not a real UGC monologue. Prevents the 28.1.4 failure mode where
 * "no transcript" got TTS'd verbatim and shipped as the output
 * voiceover.
 */
function isCondenserRefusalOutput(text: string): boolean {
  if (text.length > 400) return false; // Real monologues are longer.
  const lower = text.toLowerCase();
  const refusalMarkers = [
    'no transcript',
    'no script',
    'no analysis',
    'no vision analysis',
    'cannot condense',
    "can't condense",
    'unable to condense',
    'no source',
    'no content to',
    'nothing to condense',
    'not provided',
    'no input',
    'empty input',
    'i cannot',
    "i can't",
  ];
  return refusalMarkers.some((m) => lower.includes(m));
}
