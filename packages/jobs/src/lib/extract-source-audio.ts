import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpegPath } from './video-compress';

/**
 * Polish-28.0.0 Commit 64: source-audio extractor for ElevenLabs
 * Instant Voice Clone.
 *
 * Contract:
 *   Input:  source ad video URL (Supabase-hosted, publicly
 *           accessible from the worker)
 *   Output: MP3 bytes ≥60s (looped end-to-end if the source is
 *           shorter than 60s, up to 5 iterations)
 *
 * Loop mitigation (per operator spec):
 *   - If source audio duration ≥ 60s: extract as-is
 *   - If < 60s: loop with 200ms silence between iterations until
 *     total duration ≥ 60s
 *   - Max 5 loops. If 5 loops still < 60s (i.e. source < 12s),
 *     fail with actionable message
 *   - If source < 15s BASE: also fail (avoids unusable clones)
 *
 * ffmpeg command shape (single-pass, no manual concat file):
 *
 *   ffmpeg -i src.mp4 \
 *     -filter_complex "[0:a]aloop=loop=<N>:size=2e+09,apad=pad_dur=0.2[a]" \
 *     -map "[a]" -t 65 -acodec libmp3lame -q:a 4 out.mp3
 *
 * `aloop=loop=N:size=2e9` repeats the entire audio stream N times.
 * `apad=pad_dur=0.2` appends 200ms silence between loops. `-t 65`
 * caps at 65s so we don't emit runaway files. `q:a 4` is
 * ~128-160kbps VBR — well within ElevenLabs' 10MB per-file cap
 * for a ~65s clip.
 *
 * Duration probe: pre-pass runs `ffprobe` (or `ffmpeg -f null - -i`)
 * to measure source audio duration and calculate loop factor.
 *
 * Rejection cases (surfaced as ExtractSourceAudioError):
 *   - `source-video-fetch-failed` — the input URL 4xx/5xxed or
 *     network error before we could read bytes
 *   - `no-audio-stream` — the source video has no audio track
 *   - `source-too-short` — source audio < 15s base
 *   - `ffmpeg-missing` — no ffmpeg binary on PATH + no installer dep
 *   - `ffmpeg-failed` — spawn error or non-zero exit
 */

const AUDIO_MIN_DURATION_SECONDS = 60;
const AUDIO_TARGET_DURATION_SECONDS = 65;
const AUDIO_MAX_LOOPS = 5;
const AUDIO_MIN_BASE_DURATION_SECONDS = 15;

export type ExtractSourceAudioFailureReason =
  | 'source-video-fetch-failed'
  | 'no-audio-stream'
  | 'source-too-short'
  | 'ffmpeg-missing'
  | 'ffmpeg-failed';

export interface ExtractSourceAudioInput {
  /** Fetchable URL to the source ad video (Supabase public, typically). */
  sourceVideoUrl: string;
  /** Optional MIME hint if the URL doesn't respond with a content-type. */
  sourceMimeHint?: string;
}

export interface ExtractSourceAudioResult {
  ok: true;
  /** Loop-mitigated MP3 bytes ready for ElevenLabs multipart upload. */
  audioBytes: Uint8Array;
  audioMimeType: 'audio/mpeg';
  audioFilename: 'source-loop.mp3';
  /** Measured base (pre-loop) duration in seconds. */
  baseDurationSeconds: number;
  /** How many total playthroughs of the source were concatenated. */
  loopFactor: number;
  /** Actual output duration after loop + apad + -t cap. */
  finalDurationSeconds: number;
}

export interface ExtractSourceAudioFailure {
  ok: false;
  reason: ExtractSourceAudioFailureReason;
  detail: string;
  /** For diagnostics — populated where available. */
  baseDurationSeconds?: number;
  loopFactor?: number;
}

export type ExtractSourceAudioOutcome = ExtractSourceAudioResult | ExtractSourceAudioFailure;

/**
 * Extract + loop-mitigate MP3 audio from a source ad URL.
 *
 * Two ffmpeg passes:
 *   1. Probe the source's audio duration
 *   2. Extract → optionally loop → MP3 encode
 *
 * Both run in a per-call temp dir that's rm -rf'd in `finally`.
 */
export async function extractSourceAudioLoopMitigated(
  input: ExtractSourceAudioInput,
): Promise<ExtractSourceAudioOutcome> {
  const ffmpegPath = resolveFfmpegPath();

  // Fetch source video bytes.
  let sourceBuffer: Buffer;
  try {
    const res = await fetch(input.sourceVideoUrl);
    if (!res.ok) {
      return {
        ok: false,
        reason: 'source-video-fetch-failed',
        detail: `HTTP ${res.status} fetching ${input.sourceVideoUrl.slice(0, 200)}`,
      };
    }
    const arr = await res.arrayBuffer();
    sourceBuffer = Buffer.from(arr);
  } catch (err) {
    return {
      ok: false,
      reason: 'source-video-fetch-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const workDir = await mkdtemp(join(tmpdir(), 'polish28-src-audio-'));
  const srcExtension = guessExtensionFromMime(input.sourceMimeHint) ?? 'mp4';
  const srcPath = join(workDir, `source.${srcExtension}`);
  const outPath = join(workDir, 'source-loop.mp3');

  try {
    await writeFile(srcPath, sourceBuffer);

    // Pass 1: probe duration.
    const probeResult = await probeAudioDuration(ffmpegPath, srcPath);
    if (!probeResult.ok) {
      return probeResult;
    }
    const baseDurationSeconds = probeResult.duration;
    if (baseDurationSeconds < AUDIO_MIN_BASE_DURATION_SECONDS) {
      return {
        ok: false,
        reason: 'source-too-short',
        detail:
          `Source audio is ${baseDurationSeconds.toFixed(1)}s but Polish-28 requires at least ` +
          `${AUDIO_MIN_BASE_DURATION_SECONDS}s to produce a usable ElevenLabs Instant Voice ` +
          `Clone. Use a longer source ad (25s+ recommended).`,
        baseDurationSeconds,
      };
    }

    // Compute loop factor. `loopFactor` is how many times the source
    // audio is played end-to-end (loopFactor=1 → no loop, just extract).
    let loopFactor = 1;
    while (
      loopFactor < AUDIO_MAX_LOOPS + 1 &&
      loopFactor * baseDurationSeconds < AUDIO_MIN_DURATION_SECONDS
    ) {
      loopFactor++;
    }
    if (loopFactor * baseDurationSeconds < AUDIO_MIN_DURATION_SECONDS) {
      // Even at AUDIO_MAX_LOOPS+1 loops we're below target — reject.
      return {
        ok: false,
        reason: 'source-too-short',
        detail:
          `Source audio is ${baseDurationSeconds.toFixed(1)}s; after ${AUDIO_MAX_LOOPS} loops ` +
          `(${(baseDurationSeconds * AUDIO_MAX_LOOPS).toFixed(1)}s) still under the ` +
          `${AUDIO_MIN_DURATION_SECONDS}s ElevenLabs IVC minimum. Use a longer source ad.`,
        baseDurationSeconds,
        loopFactor: AUDIO_MAX_LOOPS,
      };
    }

    // Pass 2: extract + loop + MP3 encode.
    // aloop's `loop` arg = additional plays (not total). So aloop=loop=(loopFactor-1)
    // gives us `loopFactor` total playthroughs. size=2e9 samples caps the internal
    // buffer (well above any real source's sample count).
    const loopArg = Math.max(0, loopFactor - 1);
    const filter =
      loopArg > 0
        ? `[0:a]aloop=loop=${loopArg}:size=2000000000,apad=pad_dur=0.2[a]`
        : `[0:a]anull[a]`;
    const extractArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      srcPath,
      '-filter_complex',
      filter,
      '-map',
      '[a]',
      '-t',
      String(AUDIO_TARGET_DURATION_SECONDS),
      '-vn',
      '-acodec',
      'libmp3lame',
      '-q:a',
      '4',
      '-y',
      outPath,
    ];
    const extract = await runFfmpeg(ffmpegPath, extractArgs);
    if (!extract.ok) {
      return {
        ok: false,
        reason: extract.reason,
        detail: extract.detail,
        baseDurationSeconds,
        loopFactor,
      };
    }

    // Sanity check the output file exists + non-empty.
    const outStat = await stat(outPath).catch(() => null);
    if (!outStat || outStat.size === 0) {
      return {
        ok: false,
        reason: 'ffmpeg-failed',
        detail: 'ffmpeg exited 0 but produced no MP3 output.',
        baseDurationSeconds,
        loopFactor,
      };
    }

    const audioBuffer = await readFile(outPath);
    const audioBytes = new Uint8Array(
      audioBuffer.buffer,
      audioBuffer.byteOffset,
      audioBuffer.byteLength,
    );

    return {
      ok: true,
      audioBytes,
      audioMimeType: 'audio/mpeg',
      audioFilename: 'source-loop.mp3',
      baseDurationSeconds,
      loopFactor,
      // With aloop + -t 65, the actual output is min(loopFactor*base, 65).
      finalDurationSeconds: Math.min(
        loopFactor * baseDurationSeconds,
        AUDIO_TARGET_DURATION_SECONDS,
      ),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {
      // Cleanup is best-effort; a leaked temp dir on Vercel is
      // ephemeral (function invocation ends → filesystem discarded).
    });
  }
}

/**
 * Probe source audio duration via a null-mux ffmpeg pass. Returns
 * a normalized outcome so callers can bubble the ffmpeg-missing /
 * no-audio-stream cases without a second try/catch.
 */
async function probeAudioDuration(
  ffmpegPath: string,
  srcPath: string,
): Promise<
  | { ok: true; duration: number }
  | { ok: false; reason: ExtractSourceAudioFailureReason; detail: string }
> {
  // Use `-f null -` output — parses the source, emits duration on stderr,
  // no output file written.
  const args = ['-hide_banner', '-i', srcPath, '-f', 'null', '-'];
  const result = await runFfmpeg(ffmpegPath, args, { captureStderr: true });
  if (!result.ok) {
    // If ffmpeg reports "Stream #0:0 does not contain any stream" or similar,
    // classify as no-audio-stream. Otherwise ffmpeg-failed.
    const isNoAudio = /no audio|does not contain any stream|Invalid data/i.test(result.detail);
    return {
      ok: false,
      reason: isNoAudio ? 'no-audio-stream' : result.reason,
      detail: result.detail,
    };
  }
  // stderr shape: 'Duration: HH:MM:SS.dd, ...'.
  const stderr = result.stderr ?? '';
  const match = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
  if (!match) {
    // Confirm the stream even has audio.
    if (!/Stream #\d+:\d+.*Audio:/i.test(stderr)) {
      return {
        ok: false,
        reason: 'no-audio-stream',
        detail: 'Source video has no audio stream (ffmpeg stderr contained no Audio: line).',
      };
    }
    return {
      ok: false,
      reason: 'ffmpeg-failed',
      detail: `Could not parse duration from ffmpeg output: ${stderr.slice(0, 400)}`,
    };
  }
  const hours = Number(match[1]!);
  const mins = Number(match[2]!);
  const secs = Number(match[3]!);
  const frac = Number('0.' + match[4]!);
  const duration = hours * 3600 + mins * 60 + secs + frac;
  return { ok: true, duration };
}

/** Run ffmpeg with args; return normalized outcome. */
async function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  opts: { captureStderr?: boolean } = {},
): Promise<
  | { ok: true; stderr?: string }
  | { ok: false; reason: 'ffmpeg-missing' | 'ffmpeg-failed'; detail: string; stderr?: string }
> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      if (opts.captureStderr) stderrChunks.push(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      const isNotFound = err.code === 'ENOENT';
      resolve({
        ok: false,
        reason: isNotFound ? 'ffmpeg-missing' : 'ffmpeg-failed',
        detail: err.message,
      });
    });
    child.on('close', (code) => {
      const stderr = opts.captureStderr ? Buffer.concat(stderrChunks).toString('utf8') : undefined;
      if (code === 0) {
        return resolve(opts.captureStderr ? { ok: true, stderr } : { ok: true });
      }
      // `ffmpeg -i src -f null -` exits non-zero when the input has issues,
      // but the probe still returns a Duration line in some builds. Callers
      // that captureStderr can differentiate.
      resolve({
        ok: false,
        reason: 'ffmpeg-failed',
        detail: `ffmpeg exited ${code}. stderr: ${stderr?.slice(0, 400) ?? '(not captured)'}`,
        ...(stderr !== undefined ? { stderr } : {}),
      });
    });
  });
}

function guessExtensionFromMime(mime: string | undefined): string | null {
  if (!mime) return null;
  const normalized = mime.toLowerCase();
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('quicktime') || normalized.includes('mov')) return 'mov';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('mpeg')) return 'mpg';
  if (normalized.includes('matroska') || normalized.includes('mkv')) return 'mkv';
  return null;
}
