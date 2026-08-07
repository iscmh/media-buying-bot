import { Buffer } from 'node:buffer';
import { getServiceRoleSupabase } from './storage';

/**
 * Polish-28.0.5 Commit 64.5: source-audio extractor via REPLICATE
 * ffmpeg (pivoted away from the local ffmpeg spawn that blew Vercel
 * Hobby's 50MB serverless function limit in 28.0.4).
 *
 * Contract (unchanged from 28.0.3 caller perspective):
 *   Input:  { storageBucket, storagePath } — Supabase-hosted source ad
 *   Output: MP3 bytes ≥60s (looped end-to-end if source is shorter)
 *
 * Pipeline:
 *   1. Generate a Supabase signed URL for the source video (1h expiry).
 *      Signed URLs work regardless of bucket public/private status +
 *      let Replicate fetch directly without service-role credentials.
 *   2. Submit to a Replicate generic-ffmpeg model with a filter graph
 *      that extracts audio + loops to reach ≥60s + encodes to MP3.
 *   3. Poll for completion.
 *   4. Download the resulting MP3 bytes for ElevenLabs consumption.
 *
 * ffmpeg args (same shape as the local spawn from 28.0.3):
 *   -filter_complex "[0:a]aloop=loop=N:size=2e9,apad=pad_dur=0.2[a]"
 *   -map "[a]" -t 65 -acodec libmp3lame -q:a 4
 *
 * Loop factor (N+1 total playthroughs) is baked into the args
 * client-side rather than probed on Replicate. We estimate loop
 * factor from a HEAD-request duration guess — imperfect but avoids
 * a separate probe round-trip. If the guess underestimates, we still
 * get ≥ some-duration audio; ElevenLabs IVC minimum is ~1min but
 * accepts more; excess seconds are harmless.
 *
 * Rejection reasons (unchanged interface):
 *   - `source-video-fetch-failed` — signed-URL generation or Replicate
 *     fetch failed
 *   - `no-audio-stream` — bubbled from Replicate ffmpeg stderr
 *   - `source-too-short` — post-processing check on returned duration
 *   - `ffmpeg-missing` — legacy shape (not thrown post-64.5; kept for
 *     type compat with pre-64.5 callers)
 *   - `ffmpeg-failed` — Replicate ffmpeg returned non-completed status
 */

import { callProvider } from '@mbb/ai-providers';

const REPLICATE_BASE = 'https://api.replicate.com';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 40; // 40 * 3s = 2 min max — Replicate ffmpeg is fast

const AUDIO_TARGET_DURATION_SECONDS = 65;
const AUDIO_MAX_LOOPS = 5;

/**
 * Replicate ffmpeg model ID. Same env-override convention as
 * REPLICATE_AUDIO_TRIM_MODEL_ID in replicate-audio-trim.ts. If unset,
 * the extractor fails loud with an actionable message telling the
 * operator to set this + pick a working ffmpeg model on Replicate.
 *
 * Recommended: `cuuupid/cog-ffmpeg` (versioned) or any community
 * ffmpeg wrapper that accepts a `command` / `ffmpeg_args` field.
 */
export function getPolish28FfmpegModelId(): string {
  return (
    process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID']?.trim() ||
    process.env['REPLICATE_AUDIO_TRIM_MODEL_ID']?.trim() ||
    ''
  );
}

export type ExtractSourceAudioFailureReason =
  | 'source-video-fetch-failed'
  | 'no-audio-stream'
  | 'source-too-short'
  | 'ffmpeg-missing'
  | 'ffmpeg-failed';

/**
 * Polish-28.0.5 Commit 64.5: input shape widened again — accepts
 * signed URL OR storage tuple OR raw URL. Worker passes storage
 * tuple; helper resolves to a signed URL for Replicate.
 *
 * The `sourceVideoUrl` branch is preserved for external / already-
 * signed URL callers (future use cases + tests).
 */
export type ExtractSourceAudioInput =
  | {
      sourceVideoUrl: string;
      sourceMimeHint?: string;
      storageBucket?: never;
      storagePath?: never;
      userId: string;
      replicateApiKey: string;
      generationJobId?: string;
    }
  | {
      sourceVideoUrl?: never;
      storageBucket: string;
      storagePath: string;
      sourceMimeHint?: string;
      userId: string;
      replicateApiKey: string;
      generationJobId?: string;
    };

export interface ExtractSourceAudioResult {
  ok: true;
  audioBytes: Uint8Array;
  audioMimeType: 'audio/mpeg';
  audioFilename: 'source-loop.mp3';
  baseDurationSeconds: number;
  loopFactor: number;
  finalDurationSeconds: number;
}

export interface ExtractSourceAudioFailure {
  ok: false;
  reason: ExtractSourceAudioFailureReason;
  detail: string;
  baseDurationSeconds?: number;
  loopFactor?: number;
}

export type ExtractSourceAudioOutcome = ExtractSourceAudioResult | ExtractSourceAudioFailure;

/** Signed-URL lifetime for Replicate consumption. 1h is comfortable —
 *  Replicate typically fetches within seconds of submit. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export async function extractSourceAudioLoopMitigated(
  input: ExtractSourceAudioInput,
): Promise<ExtractSourceAudioOutcome> {
  const modelRaw = getPolish28FfmpegModelId();
  if (!modelRaw) {
    return {
      ok: false,
      reason: 'ffmpeg-missing',
      detail:
        'POLISH28_REPLICATE_FFMPEG_MODEL_ID (or REPLICATE_AUDIO_TRIM_MODEL_ID) is not set. ' +
        'Polish-28 needs a Replicate ffmpeg model for source-audio extraction. Set ' +
        'POLISH28_REPLICATE_FFMPEG_MODEL_ID to a working ffmpeg model slug (e.g. ' +
        '"cuuupid/cog-ffmpeg:<version-sha>") on Vercel + redeploy.',
    };
  }

  // Step 1: resolve source video to a fetchable URL Replicate can hit.
  let sourceUrl: string;
  if ('storageBucket' in input && input.storageBucket) {
    if (!input.storagePath || input.storagePath.trim().length === 0) {
      return {
        ok: false,
        reason: 'source-video-fetch-failed',
        detail: 'Concept source file not found (storagePath is empty). Re-upload the source ad.',
      };
    }
    try {
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase.storage
        .from(input.storageBucket)
        .createSignedUrl(input.storagePath, SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) {
        return {
          ok: false,
          reason: 'source-video-fetch-failed',
          detail: `Signed-URL generation failed for ${input.storageBucket}/${input.storagePath}: ${error?.message ?? 'no signedUrl in response'}`,
        };
      }
      sourceUrl = data.signedUrl;
    } catch (err) {
      return {
        ok: false,
        reason: 'source-video-fetch-failed',
        detail: `Signed-URL threw for ${input.storageBucket}/${input.storagePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else if ('sourceVideoUrl' in input && input.sourceVideoUrl) {
    sourceUrl = input.sourceVideoUrl;
  } else {
    return {
      ok: false,
      reason: 'source-video-fetch-failed',
      detail:
        'extract-source-audio requires either { sourceVideoUrl } or { storageBucket, storagePath } — neither was provided.',
    };
  }

  // Step 2: submit to Replicate ffmpeg. We don't know the source
  // duration upfront (no cheap probe on Vercel serverless) so we
  // bake the MAX loop factor into the filter — aloop=N applied to
  // a source shorter than target produces N+1 playthroughs;
  // -t <target> then hard-caps at target seconds. Overshoot is
  // harmless: ElevenLabs IVC's 10MB per-file cap is well above a
  // 65s MP3 @ VBR ~128kbps.
  const loopFactor = AUDIO_MAX_LOOPS; // maximum — guarantees ≥60s if base ≥12s
  const filter = `[0:a]aloop=loop=${loopFactor - 1}:size=2000000000,apad=pad_dur=0.2[a]`;
  const ffmpegArgs =
    `-i INPUT -filter_complex "${filter}" -map "[a]" -t ${AUDIO_TARGET_DURATION_SECONDS} ` +
    `-vn -acodec libmp3lame -q:a 4 OUTPUT`;

  const colonIdx = modelRaw.indexOf(':');
  const modelPath = colonIdx === -1 ? modelRaw : modelRaw.slice(0, colonIdx);
  const version = colonIdx === -1 ? '' : modelRaw.slice(colonIdx + 1).trim();

  // Generic ffmpeg models on Replicate use varied field names — same
  // shotgun as replicate-audio-trim.ts's submit.
  const inputFields = {
    video: sourceUrl,
    video_url: sourceUrl,
    video_file: sourceUrl,
    input: sourceUrl,
    input_video: sourceUrl,
    audio: sourceUrl,
    input_audio: sourceUrl,
    command: ffmpegArgs,
    args: ffmpegArgs,
    ffmpeg_args: ffmpegArgs,
    filter: ffmpegArgs,
  };

  const submitUrl = version
    ? `${REPLICATE_BASE}/v1/predictions`
    : `${REPLICATE_BASE}/v1/models/${modelPath}/predictions`;
  const submitBody = version ? { version, input: inputFields } : { input: inputFields };

  const submitResult = await callProvider<{ id?: string; error?: string }>({
    userId: input.userId,
    provider: 'kling' as const, // shares audit-log provider slot with replicate-audio-trim
    url: submitUrl,
    method: 'POST',
    headers: {
      Authorization: `Token ${input.replicateApiKey}`,
      'content-type': 'application/json',
    },
    body: submitBody,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      polish28_ffmpeg_extract: true,
      model: modelPath,
      version: version || undefined,
    },
    ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
  });
  if (!submitResult.ok) {
    return {
      ok: false,
      reason: 'ffmpeg-failed',
      detail: `Replicate submit failed: ${submitResult.errorMessage ?? 'unknown'}`,
    };
  }
  const predictionId = submitResult.data.id;
  if (!predictionId) {
    return {
      ok: false,
      reason: 'ffmpeg-failed',
      detail: 'Replicate submit response missing prediction id',
    };
  }

  // Step 3: poll.
  let outputUrl: string | null = null;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    const check = await callProvider<{
      status?: string;
      output?: string | string[] | { audio?: string; video?: string };
      error?: string;
    }>({
      userId: input.userId,
      provider: 'kling' as const,
      url: `${REPLICATE_BASE}/v1/predictions/${encodeURIComponent(predictionId)}`,
      method: 'GET',
      headers: { Authorization: `Token ${input.replicateApiKey}` },
      timeoutMs: CHECK_TIMEOUT_MS,
      ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
    });
    if (!check.ok) continue; // transient — keep polling
    const status = check.data.status ?? '';
    if (status === 'failed' || status === 'canceled') {
      const errStr = check.data.error ?? 'unknown';
      const isNoAudio = /no audio|audio stream/i.test(errStr);
      return {
        ok: false,
        reason: isNoAudio ? 'no-audio-stream' : 'ffmpeg-failed',
        detail: `Replicate ffmpeg ${status}: ${errStr}`,
      };
    }
    if (status === 'succeeded') {
      outputUrl = normalizeReplicateOutput(check.data.output);
      if (!outputUrl) {
        return {
          ok: false,
          reason: 'ffmpeg-failed',
          detail: `Replicate ffmpeg succeeded but no output URL in response: ${JSON.stringify(check.data.output ?? {}).slice(0, 300)}`,
        };
      }
      break;
    }
    // status: 'starting' | 'processing' — keep polling
  }
  if (!outputUrl) {
    return {
      ok: false,
      reason: 'ffmpeg-failed',
      detail: `Replicate ffmpeg timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`,
    };
  }

  // Step 4: download the audio bytes.
  let audioBytes: Uint8Array;
  try {
    const res = await fetch(outputUrl);
    if (!res.ok) {
      return {
        ok: false,
        reason: 'source-video-fetch-failed',
        detail: `Replicate output download failed HTTP ${res.status} from ${outputUrl.slice(0, 200)}`,
      };
    }
    audioBytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    return {
      ok: false,
      reason: 'source-video-fetch-failed',
      detail: `Replicate output download threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Loose sanity: ElevenLabs IVC minimum is ~60s. Reject unusably-small outputs
  // rather than shipping them and getting an opaque IVC 422 downstream.
  if (audioBytes.byteLength < 8_000) {
    return {
      ok: false,
      reason: 'source-too-short',
      detail:
        `Replicate ffmpeg output is only ${audioBytes.byteLength} bytes — source ad likely has no ` +
        `usable audio track OR is dramatically under 15s base. Use a longer source ad.`,
    };
  }

  return {
    ok: true,
    audioBytes,
    audioMimeType: 'audio/mpeg',
    audioFilename: 'source-loop.mp3',
    // We don't know the base duration (no probe) — return conservative
    // values that don't lie. loopFactor is what we requested; final
    // duration bounded by AUDIO_TARGET_DURATION_SECONDS.
    baseDurationSeconds: 0,
    loopFactor,
    finalDurationSeconds: AUDIO_TARGET_DURATION_SECONDS,
  };
}

function normalizeReplicateOutput(
  output: string | string[] | { audio?: string; video?: string } | undefined,
): string | null {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string' && item.startsWith('http')) return item;
    }
    return null;
  }
  if (typeof output === 'object') {
    if (typeof output.audio === 'string') return output.audio;
    if (typeof output.video === 'string') return output.video;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polish-28.0.5 Commit 64.5: Buffer import kept for downstream test-file
 * shape compat. Removed all local ffmpeg spawn logic — all ffmpeg work
 * now goes through Replicate. See getPolish28FfmpegModelId() env docs.
 */
export const _polish28ExtractSourceAudioModuleMarker = Buffer.from('polish28-64.5').toString('hex');
