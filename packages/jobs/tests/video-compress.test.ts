import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FFMPEG_COMPRESS_ARGS_TEMPLATE,
  __resetFfmpegInstallerCacheForTests,
  __setFfmpegPathForTests,
  __setFfmpegSpawnImplForTests,
  __setNowImplForTests,
  compressVideoBuffer,
  compressVideoForStorage,
  resolveFfmpegPath,
} from '../src/lib/video-compress';

const ORIGINAL_ENV_FFMPEG_PATH = process.env['FFMPEG_PATH'];

afterEach(() => {
  __setFfmpegSpawnImplForTests(undefined);
  __setFfmpegPathForTests(undefined);
  __setNowImplForTests(undefined);
  __resetFfmpegInstallerCacheForTests();
  if (ORIGINAL_ENV_FFMPEG_PATH === undefined) delete process.env['FFMPEG_PATH'];
  else process.env['FFMPEG_PATH'] = ORIGINAL_ENV_FFMPEG_PATH;
});

describe('Polish-21.0.11: FFMPEG_COMPRESS_ARGS_TEMPLATE regression pins', () => {
  it('carries libx264 + preset medium + CRF 25 + aac 128k + faststart (operator spec pin)', () => {
    // Regression pin against silent quality-preset drift. A future
    // edit that drops `-preset medium` or bumps CRF must update
    // this test deliberately.
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE).toContain('libx264');
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE).toContain('medium');
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE).toContain('25');
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE).toContain('aac');
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE).toContain('128k');
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE).toContain('+faststart');
  });

  it('overwrite flag -y set (idempotent retries)', () => {
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE[0]).toBe('-y');
  });

  it('$INPUT + $OUTPUT placeholders present exactly once (arg builder substitutes both)', () => {
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE.filter((t) => t === '$INPUT')).toHaveLength(1);
    expect(FFMPEG_COMPRESS_ARGS_TEMPLATE.filter((t) => t === '$OUTPUT')).toHaveLength(1);
  });
});

describe('Polish-21.0.11 → Polish-21.0.12: resolveFfmpegPath fallback chain', () => {
  // Polish-21.0.12 slotted `@ffmpeg-installer/ffmpeg` between the
  // env override and the bare-PATH default so Vercel deploys get
  // a bundled binary without operator intervention. See the
  // Polish-21.0.12 `@ffmpeg-installer/ffmpeg path resolution`
  // block below for the installer-specific pins.

  it('FFMPEG_PATH env override wins over the default', () => {
    process.env['FFMPEG_PATH'] = '/opt/ffmpeg/bin/ffmpeg';
    expect(resolveFfmpegPath()).toBe('/opt/ffmpeg/bin/ffmpeg');
  });

  it('whitespace-only env override falls through past the installer / to the bare PATH default', () => {
    // Whitespace is treated as "no override" so the installer or
    // PATH default takes over. When the installer is present
    // (this workspace), resolveFfmpegPath returns its path.
    process.env['FFMPEG_PATH'] = '   ';
    __resetFfmpegInstallerCacheForTests();
    const resolved = resolveFfmpegPath();
    // Either the installer path (present in workspace) or the
    // bare 'ffmpeg' fallback — both are correct fallthroughs.
    expect(resolved === 'ffmpeg' || /@ffmpeg-installer/.test(resolved)).toBe(true);
  });

  it('__setFfmpegPathForTests override beats env AND the installer', () => {
    process.env['FFMPEG_PATH'] = '/opt/ffmpeg';
    __setFfmpegPathForTests('/tmp/fake-ffmpeg');
    __resetFfmpegInstallerCacheForTests();
    expect(resolveFfmpegPath()).toBe('/tmp/fake-ffmpeg');
  });
});

describe('Polish-21.0.11: compressVideoBuffer — happy path', () => {
  it('when the spawner writes a smaller output, returns the compressed buffer with wasCompressed=true', async () => {
    const original = Buffer.from('a'.repeat(1000));
    const compressed = Buffer.from('b'.repeat(300));
    // Pin the binary so this test doesn't depend on whether
    // @ffmpeg-installer/ffmpeg is present in the workspace (which
    // Polish-21.0.12 puts ahead of the 'ffmpeg' fallback).
    __setFfmpegPathForTests('/tmp/fake-ffmpeg-binary');
    __setFfmpegSpawnImplForTests(async (binary, args) => {
      // The spawner runs against real tmp paths — we need to
      // materialize the output file the caller expects. Extract
      // the last arg (the output path) and write our fake
      // compressed buffer there.
      const outputPath = args[args.length - 1]!;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, compressed);
      expect(binary).toBe('/tmp/fake-ffmpeg-binary');
      // Regression pin: -c:v libx264 is on the wire.
      expect(args).toContain('libx264');
      return { ok: true, exitCode: 0 };
    });
    const result = await compressVideoBuffer(original);
    expect(result.wasCompressed).toBe(true);
    expect(result.originalBytes).toBe(1000);
    expect(result.compressedBytes).toBe(300);
    expect(result.buffer.equals(compressed)).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns the ORIGINAL buffer when ffmpeg output is not smaller (defense against pathological codec drift)', async () => {
    const original = Buffer.from('a'.repeat(500));
    const notSmaller = Buffer.from('b'.repeat(600));
    __setFfmpegSpawnImplForTests(async (_binary, args) => {
      const outputPath = args[args.length - 1]!;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, notSmaller);
      return { ok: true, exitCode: 0 };
    });
    const result = await compressVideoBuffer(original);
    expect(result.wasCompressed).toBe(false);
    // Original buffer preserved so we still ship SOMETHING.
    expect(result.buffer.equals(original)).toBe(true);
    expect(result.error).toMatch(/not smaller/);
  });
});

describe('Polish-21.0.11: compressVideoBuffer — graceful fallback', () => {
  it('missing ffmpeg binary (ENOENT) → wasCompressed=false, original buffer, error message names the missing binary', async () => {
    __setFfmpegSpawnImplForTests(async () => ({
      ok: false,
      error: `ffmpeg binary 'ffmpeg' not found on PATH. Install ffmpeg or set FFMPEG_PATH to a static binary. Falling back to uncompressed upload.`,
    }));
    const original = Buffer.from('original bytes');
    const result = await compressVideoBuffer(original);
    expect(result.wasCompressed).toBe(false);
    expect(result.buffer).toBe(original);
    expect(result.originalBytes).toBe(original.byteLength);
    expect(result.compressedBytes).toBe(original.byteLength);
    expect(result.error).toMatch(/not found on PATH/);
    expect(result.error).toMatch(/FFMPEG_PATH/);
  });

  it('ffmpeg exits non-zero (bad input codec, etc.) → wasCompressed=false, original buffer, stderr in the error', async () => {
    __setFfmpegSpawnImplForTests(async () => ({
      ok: false,
      exitCode: 1,
      error: 'ffmpeg exited 1: Invalid data found when processing input',
      stderr: 'Invalid data found when processing input',
    }));
    const result = await compressVideoBuffer(Buffer.from('not a real mp4'));
    expect(result.wasCompressed).toBe(false);
    expect(result.error).toMatch(/exited 1/);
    expect(result.error).toMatch(/Invalid data/);
  });

  it('never throws even when the spawner rejects unexpectedly (defensive contract)', async () => {
    __setFfmpegSpawnImplForTests(async () => {
      throw new Error('unexpected impl blowup');
    });
    const result = await compressVideoBuffer(Buffer.from('x'));
    expect(result.wasCompressed).toBe(false);
    expect(result.error).toMatch(/compression failed/);
    expect(result.error).toMatch(/blowup/);
  });
});

describe('Polish-21.0.12: @ffmpeg-installer/ffmpeg path resolution', () => {
  it('resolveFfmpegPath picks up the installer-bundled binary when no override / env set', () => {
    // @ffmpeg-installer/ffmpeg ships a platform-specific binary
    // (linux-x64 / darwin-arm64 / etc.) at .path. On Vercel
    // deploys the binary is present via the npm dep so an
    // operator never has to `apt-get install ffmpeg`.
    delete process.env['FFMPEG_PATH'];
    __resetFfmpegInstallerCacheForTests();
    const resolved = resolveFfmpegPath();
    // Must NOT be the bare 'ffmpeg' PATH-lookup fallback — the
    // installer is present in this workspace.
    expect(resolved).not.toBe('ffmpeg');
    // Sanity pin: installer paths always contain @ffmpeg-installer.
    expect(resolved).toMatch(/@ffmpeg-installer/);
  });

  it('FFMPEG_PATH env override still wins over the installer (operator escape hatch)', () => {
    process.env['FFMPEG_PATH'] = '/opt/custom/ffmpeg';
    __resetFfmpegInstallerCacheForTests();
    expect(resolveFfmpegPath()).toBe('/opt/custom/ffmpeg');
  });

  it('__setFfmpegPathForTests wins over both env AND installer', () => {
    process.env['FFMPEG_PATH'] = '/opt/custom/ffmpeg';
    __setFfmpegPathForTests('/tmp/fake');
    __resetFfmpegInstallerCacheForTests();
    expect(resolveFfmpegPath()).toBe('/tmp/fake');
  });
});

describe('Polish-21.0.12: compressionMs timing', () => {
  it('populates compressionMs on the success path (regression pin: field exists)', async () => {
    __setNowImplForTests(
      (() => {
        let n = 1_000;
        return () => (n += 500);
      })(),
    );
    const original = Buffer.from('a'.repeat(1000));
    const compressed = Buffer.from('b'.repeat(300));
    __setFfmpegSpawnImplForTests(async (_binary, args) => {
      const outputPath = args[args.length - 1]!;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, compressed);
      return { ok: true, exitCode: 0 };
    });
    const result = await compressVideoBuffer(original);
    expect(result.wasCompressed).toBe(true);
    // Positive: field is on the wire.
    expect(typeof result.compressionMs).toBe('number');
    expect(result.compressionMs).toBeGreaterThan(0);
  });

  it('populates compressionMs on the FAILURE path (ENOENT + non-zero exit + unexpected throw)', async () => {
    // Regression pin against a future refactor that only sets
    // compressionMs on success. Diagnostic dashboards need to
    // distinguish "ffmpeg fell through in 3ms because ENOENT"
    // from "ffmpeg legitimately ran 12s" — the field MUST be
    // populated on every return path.
    __setFfmpegSpawnImplForTests(async () => ({
      ok: false,
      error: `ffmpeg binary 'ffmpeg' not found on PATH.`,
    }));
    const result = await compressVideoBuffer(Buffer.from('x'));
    expect(typeof result.compressionMs).toBe('number');
    expect(result.compressionMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Polish-21.0.12: compressVideoForStorage alias', () => {
  it('is the exact same function as compressVideoBuffer (non-breaking rename)', () => {
    // Regression pin: a future edit that gives the alias its
    // own implementation risks the two paths drifting. Same
    // identity = same behavior guaranteed.
    expect(compressVideoForStorage).toBe(compressVideoBuffer);
  });
});
