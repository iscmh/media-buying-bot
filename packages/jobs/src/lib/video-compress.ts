import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Buffer } from 'node:buffer';

/**
 * Polish-21.0.11 hotfix: compress Hedra-generated mp4 outputs
 * before Supabase upload so they fit under the operator's 50MB
 * bucket cap. Kling Avatar v2 Standard 30s 720p output is
 * ~60-100MB (unmarked h264 at Hedra's default bitrate), Kling
 * Pro can be materially larger. Character 3 720p is smaller
 * but benefits from the same pass.
 *
 * Encoding profile — matches the operator's spec:
 *   libx264 medium CRF 25 + aac 128kbps + faststart (progressive
 *   streaming). Target output ~3-8 MB for 30s 720p.
 *
 * The helper spawns a system `ffmpeg` binary at $FFMPEG_PATH (or
 * plain `ffmpeg` on PATH). No hard npm dep — deploy environments
 * can install ffmpeg-static, apt-get install ffmpeg, or bring
 * their own. Absent binary is NOT a bug: `compressVideoBuffer`
 * returns `wasCompressed: false` and hands the original buffer
 * back so the upload path keeps working on smaller outputs.
 */

/**
 * TEST-ONLY seam so tests can inject a fake ffmpeg path (e.g.
 * /bin/false to simulate a failing compress, or a shell script
 * to simulate success). Undefined = use $FFMPEG_PATH or the
 * default 'ffmpeg' PATH lookup.
 */
let _ffmpegPathOverride: string | undefined;

/** TEST-ONLY: inject the ffmpeg binary path for the next call. */
export function __setFfmpegPathForTests(path: string | undefined): void {
  _ffmpegPathOverride = path;
}

/**
 * Resolve the ffmpeg binary path with the override → env →
 * `@ffmpeg-installer/ffmpeg` → default fallback chain.
 *
 * Polish-21.0.12 hotfix: `@ffmpeg-installer/ffmpeg` slotted in
 * ahead of the raw PATH lookup so Vercel deployments (where
 * `ffmpeg` is NOT on PATH by default) find the bundled static
 * binary without operator intervention. Job 0a382842 diagnosed
 * Supabase's 50MB cap rejecting an uncompressed Kling upload —
 * root cause was compression never running because the CLI
 * spawn hit ENOENT and fell back to raw upload silently. This
 * chain guarantees a binary when the npm dep is installed.
 *
 * Fallback chain (first non-empty wins):
 *   1. __setFfmpegPathForTests()          test-only injection
 *   2. process.env.FFMPEG_PATH             operator override
 *   3. @ffmpeg-installer/ffmpeg .path      npm-bundled binary
 *   4. 'ffmpeg'                            system PATH lookup
 */
export function resolveFfmpegPath(): string {
  if (_ffmpegPathOverride) return _ffmpegPathOverride;
  const fromEnv = process.env['FFMPEG_PATH'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  const fromInstaller = tryFfmpegInstallerPath();
  if (fromInstaller) return fromInstaller;
  return 'ffmpeg';
}

/**
 * Polish-21.0.12: probe `@ffmpeg-installer/ffmpeg` at runtime.
 * Wrapped in a soft try/catch so a deploy that intentionally
 * omits the dep still works via the PATH fallback — the module
 * is an OPTIONAL runtime dep, not a hard require.
 *
 * Result is memoized because require() succeeds on subsequent
 * calls anyway but ships one less `try` per compress attempt.
 * Set to `null` after a probe failure so we don't keep retrying.
 */
let _installerPathCached: string | null | undefined;

function tryFfmpegInstallerPath(): string | null {
  if (_installerPathCached !== undefined) return _installerPathCached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@ffmpeg-installer/ffmpeg') as { path?: string };
    if (mod && typeof mod.path === 'string' && mod.path.length > 0) {
      _installerPathCached = mod.path;
      return _installerPathCached;
    }
  } catch {
    // Missing dep is fine — fall through to PATH lookup.
  }
  _installerPathCached = null;
  return null;
}

/** TEST-ONLY: reset the installer-path memoization between tests. */
export function __resetFfmpegInstallerCacheForTests(): void {
  _installerPathCached = undefined;
}

export interface CompressVideoResult {
  buffer: Buffer;
  wasCompressed: boolean;
  originalBytes: number;
  compressedBytes: number;
  /**
   * Polish-21.0.12: wall-clock milliseconds spent inside the
   * compress attempt (ffmpeg spawn + file I/O). Populated on
   * BOTH success + failure paths so the operator's diagnostic
   * dashboard can flag "ffmpeg quietly failing in <100ms" as
   * ENOENT vs "ffmpeg legitimately running 12s per variant".
   */
  compressionMs: number;
  /** Set only when wasCompressed === false. Human-readable reason. */
  error?: string;
}

/**
 * Polish-21.0.11: ffmpeg CLI args pinned as an exported constant so
 * a test can regression-pin the exact command shape. Any accidental
 * silent quality change (dropping `-preset medium`, bumping CRF)
 * fails the pin.
 *
 * Notes:
 *   -y                       overwrite output (idempotent retries)
 *   -i INPUT                 input filename
 *   -c:v libx264             widely-compatible video codec
 *   -preset medium           encode speed vs size trade-off
 *   -crf 25                  constant-quality target (~visually
 *                            transparent for UGC-style output)
 *   -c:a aac -b:a 128k       reasonable voice audio
 *   -movflags +faststart     progressive mp4 (streams before fully
 *                            downloaded)
 *   OUTPUT                   output filename
 */
export const FFMPEG_COMPRESS_ARGS_TEMPLATE: readonly string[] = [
  '-y',
  '-i',
  '$INPUT',
  '-c:v',
  'libx264',
  '-preset',
  'medium',
  '-crf',
  '25',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-movflags',
  '+faststart',
  '$OUTPUT',
];

function buildFfmpegArgs(inputPath: string, outputPath: string): string[] {
  return FFMPEG_COMPRESS_ARGS_TEMPLATE.map((tok) =>
    tok === '$INPUT' ? inputPath : tok === '$OUTPUT' ? outputPath : tok,
  );
}

/**
 * Polish-21.0.11: soft timeout on the ffmpeg subprocess. A 30s
 * 720p compress finishes in <15s on typical hardware; 90s gives
 * a lot of headroom for the operator's Vercel/Inngest workers
 * without letting a runaway process hang the variant.
 */
export const FFMPEG_COMPRESS_TIMEOUT_MS = 90_000;

/**
 * Compress a video buffer to a smaller mp4 suitable for
 * Supabase's 50 MB upload cap. Never throws — a missing binary,
 * spawn error, or ffmpeg non-zero exit falls back to the
 * original buffer with `wasCompressed: false` + an `error`
 * string the caller can log.
 *
 * Buffers are round-tripped via a per-call tmpdir under
 * os.tmpdir() so a shared /tmp doesn't collide across concurrent
 * variants. Tmpdir is cleaned up in a finally block regardless
 * of ffmpeg's exit code.
 */
export async function compressVideoBuffer(input: Buffer): Promise<CompressVideoResult> {
  const originalBytes = input.byteLength;
  const ffmpegPath = resolveFfmpegPath();
  // Polish-21.0.12 hotfix: track wall-clock time so the operator
  // can distinguish "ffmpeg legitimately ran 12s" from "ffmpeg
  // fell through in 3ms because ENOENT" in Inngest metadata.
  const t0 = nowMs();
  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), 'mbb-vc-'));
    const inputPath = join(workDir, 'input.mp4');
    const outputPath = join(workDir, 'output.mp4');
    await writeFile(inputPath, input);

    const args = buildFfmpegArgs(inputPath, outputPath);
    const spawnResult = await runFfmpeg(ffmpegPath, args);
    if (!spawnResult.ok) {
      return {
        buffer: input,
        wasCompressed: false,
        originalBytes,
        compressedBytes: originalBytes,
        compressionMs: nowMs() - t0,
        error: spawnResult.error,
      };
    }
    const compressed = await readFile(outputPath);
    // Defense-in-depth: if ffmpeg somehow produced a LARGER file
    // (weird source codec, super-low-bitrate input), keep the
    // original instead of blowing up the upload.
    if (compressed.byteLength >= input.byteLength) {
      return {
        buffer: input,
        wasCompressed: false,
        originalBytes,
        compressedBytes: originalBytes,
        compressionMs: nowMs() - t0,
        error:
          `ffmpeg output (${compressed.byteLength} bytes) not smaller than input ` +
          `(${input.byteLength} bytes); keeping original`,
      };
    }
    return {
      buffer: compressed,
      wasCompressed: true,
      originalBytes,
      compressedBytes: compressed.byteLength,
      compressionMs: nowMs() - t0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      buffer: input,
      wasCompressed: false,
      originalBytes,
      compressedBytes: originalBytes,
      compressionMs: nowMs() - t0,
      error: `video compression failed: ${msg}`,
    };
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup failure — the OS reaps the tmpdir
        // eventually and we don't want to mask the real error.
      });
    }
  }
}

/**
 * Polish-21.0.12: `Date.now()` seam so tests can pin exact
 * durations without mocking global time. Default is the real
 * monotonic clock via performance.now() when available (avoids
 * NTP jitter mid-compress), otherwise Date.now().
 */
let _nowImpl: () => number = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** TEST-ONLY: override the monotonic clock. Pass undefined to restore. */
export function __setNowImplForTests(impl: (() => number) | undefined): void {
  _nowImpl =
    impl ??
    (() =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now());
}

function nowMs(): number {
  return _nowImpl();
}

/**
 * Polish-21.0.12: named alias for the compression helper matching
 * the operator's spec-facing name (`compressVideoForStorage`).
 * Preserves `compressVideoBuffer` for existing imports so the
 * rename is non-breaking. Semantics identical.
 */
export const compressVideoForStorage = compressVideoBuffer;

interface FfmpegSpawnResult {
  ok: boolean;
  error?: string;
  exitCode?: number | null;
  stderr?: string;
}

/**
 * Spawn ffmpeg and resolve when it exits. Rejects only on
 * unrecoverable errors (spawn ENOENT); non-zero exit codes
 * resolve with `ok: false` so the caller can log stderr for the
 * operator without crashing the variant.
 *
 * Extracted so tests can override the spawner via
 * `__setFfmpegSpawnImplForTests`.
 */
function runFfmpeg(binary: string, args: readonly string[]): Promise<FfmpegSpawnResult> {
  const impl = _spawnImpl ?? defaultSpawnImpl;
  return impl(binary, args);
}

type FfmpegSpawnImpl = (binary: string, args: readonly string[]) => Promise<FfmpegSpawnResult>;

let _spawnImpl: FfmpegSpawnImpl | undefined;

/**
 * TEST-ONLY: override the ffmpeg subprocess launcher so tests can
 * simulate success / stderr-noise / ENOENT paths without a real
 * binary. Pass `undefined` to restore the real spawner.
 */
export function __setFfmpegSpawnImplForTests(impl: FfmpegSpawnImpl | undefined): void {
  _spawnImpl = impl;
}

function defaultSpawnImpl(binary: string, args: readonly string[]): Promise<FfmpegSpawnResult> {
  return new Promise<FfmpegSpawnResult>((resolve) => {
    let stderr = '';
    let settled = false;
    const finish = (result: FfmpegSpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(binary, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ ok: false, error: `ffmpeg spawn threw: ${msg}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore kill failure; the process may have already exited.
      }
      finish({
        ok: false,
        error: `ffmpeg timed out after ${FFMPEG_COMPRESS_TIMEOUT_MS}ms`,
        stderr,
      });
    }, FFMPEG_COMPRESS_TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer | string) => {
      // Cap stderr capture at 4KB so a runaway ffmpeg log tail
      // can't blow up the worker's memory.
      if (stderr.length < 4096) {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        finish({
          ok: false,
          error:
            `ffmpeg binary '${binary}' not found on PATH. ` +
            `Install ffmpeg or set FFMPEG_PATH to a static binary. ` +
            `Falling back to uncompressed upload.`,
        });
        return;
      }
      finish({ ok: false, error: `ffmpeg spawn error: ${err.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true, exitCode: 0 });
        return;
      }
      finish({
        ok: false,
        exitCode: code,
        error: `ffmpeg exited ${code}: ${stderr.slice(0, 500)}`,
        stderr,
      });
    });
  });
}
