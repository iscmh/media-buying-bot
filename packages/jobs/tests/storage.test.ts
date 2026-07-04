import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

describe('uploadGeneratedImage — Bug 1: file_url must be a full URL', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('returns a publicUrl that starts with https:// (not a bare object key)', async () => {
    const publicUrl =
      'https://test-project.supabase.co/storage/v1/object/public/generated-creatives/user-1/generated/job-1/0.png';
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        storage: {
          from: () => ({
            upload: vi.fn().mockResolvedValue({ error: null }),
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl } }),
          }),
        },
      }),
    }));
    const { uploadGeneratedImage } = await import('../src/lib/storage');
    const result = await uploadGeneratedImage({
      userId: 'user-1',
      jobId: 'job-1',
      variantIndex: 0,
      imageBase64: Buffer.from('test image').toString('base64'),
      mimeType: 'image/png',
    });

    expect(result.publicUrl).toMatch(/^https:\/\//);
    expect(result.publicUrl).toBe(publicUrl);
    // The raw object key is also returned for backend ops.
    expect(result.path).toBe('user-1/generated/job-1/0.png');
  });

  it('throws when Supabase upload errors out', async () => {
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        storage: {
          from: () => ({
            upload: vi.fn().mockResolvedValue({ error: { message: 'permission denied' } }),
            getPublicUrl: vi.fn(),
          }),
        },
      }),
    }));
    const { uploadGeneratedImage } = await import('../src/lib/storage');
    await expect(
      uploadGeneratedImage({
        userId: 'user-1',
        jobId: 'job-1',
        variantIndex: 0,
        imageBase64: Buffer.from('x').toString('base64'),
        mimeType: 'image/png',
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('Polish-21.0.11: uploadGeneratedVideoFromUrl — compression before Supabase upload', () => {
  const RAW_BYTES = Buffer.from('a'.repeat(1000));
  const COMPRESSED_BYTES = Buffer.from('b'.repeat(300));
  let uploadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    };
    vi.resetModules();
    uploadSpy = vi.fn().mockResolvedValue({ error: null });
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        storage: {
          from: () => ({
            upload: uploadSpy,
            getPublicUrl: vi.fn().mockReturnValue({
              data: {
                publicUrl:
                  'https://test-project.supabase.co/storage/v1/object/public/generated-creatives/u/generated/j/v.mp4',
              },
            }),
          }),
        },
      }),
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // Buffer.from(str).buffer includes the whole pooled backing
      // ArrayBuffer, not just the used slice — copy into a fresh
      // one so `res.arrayBuffer()` reads exactly RAW_BYTES.byteLength.
      arrayBuffer: async () =>
        RAW_BYTES.buffer.slice(RAW_BYTES.byteOffset, RAW_BYTES.byteOffset + RAW_BYTES.byteLength),
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('compress=true: Supabase upload receives the COMPRESSED buffer, sizes returned reflect both', async () => {
    // Wire the ffmpeg spawner to materialize a smaller output.
    const { __setFfmpegSpawnImplForTests } = await import('../src/lib/video-compress');
    __setFfmpegSpawnImplForTests(async (_binary, args) => {
      const outputPath = args[args.length - 1]!;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, COMPRESSED_BYTES);
      return { ok: true, exitCode: 0 };
    });
    const { uploadGeneratedVideoFromUrl } = await import('../src/lib/storage');
    const result = await uploadGeneratedVideoFromUrl({
      userId: 'u',
      jobId: 'j',
      remoteUrl: 'https://hedra/output.mp4',
      filename: 'v',
      compress: true,
    });
    // Regression pin: Supabase saw the SMALLER buffer, not the raw one.
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const uploadedBytes = uploadSpy.mock.calls[0]![1] as Buffer;
    expect(uploadedBytes.byteLength).toBe(COMPRESSED_BYTES.byteLength);
    // Return shape carries both sizes so the worker can log them.
    expect(result.originalBytes).toBe(RAW_BYTES.byteLength);
    expect(result.sizeBytes).toBe(COMPRESSED_BYTES.byteLength);
    expect(result.wasCompressed).toBe(true);
    expect(result.compressionError).toBeUndefined();
    // Polish-21.0.12: compressionMs on the wire.
    expect(typeof result.compressionMs).toBe('number');
    expect(result.compressionMs).toBeGreaterThanOrEqual(0);
    __setFfmpegSpawnImplForTests(undefined);
  });

  it('compress=true, ffmpeg missing: falls back to RAW upload with wasCompressed=false + compressionError set', async () => {
    // Regression pin: sandbox / prod-without-ffmpeg must NOT fail
    // the variant. The upload keeps working on smaller outputs
    // (Character 3) even when the compression pass is unavailable.
    const { __setFfmpegSpawnImplForTests } = await import('../src/lib/video-compress');
    __setFfmpegSpawnImplForTests(async () => ({
      ok: false,
      error: `ffmpeg binary 'ffmpeg' not found on PATH. Falling back to uncompressed upload.`,
    }));
    const { uploadGeneratedVideoFromUrl } = await import('../src/lib/storage');
    const result = await uploadGeneratedVideoFromUrl({
      userId: 'u',
      jobId: 'j',
      remoteUrl: 'https://hedra/output.mp4',
      filename: 'v',
      compress: true,
    });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const uploadedBytes = uploadSpy.mock.calls[0]![1] as Buffer;
    // Fallback: Supabase saw the RAW buffer, not a compressed one.
    expect(uploadedBytes.byteLength).toBe(RAW_BYTES.byteLength);
    expect(result.sizeBytes).toBe(RAW_BYTES.byteLength);
    expect(result.originalBytes).toBe(RAW_BYTES.byteLength);
    expect(result.wasCompressed).toBe(false);
    expect(result.compressionError).toMatch(/not found on PATH/);
    __setFfmpegSpawnImplForTests(undefined);
  });

  it('compress=false (default): NO ffmpeg attempt, upload receives raw buffer', async () => {
    // Regression pin against a future edit that flips the default
    // to compress=true and breaks non-Hedra call sites.
    const compressModule = await import('../src/lib/video-compress');
    const spawnSpy = vi.fn();
    compressModule.__setFfmpegSpawnImplForTests(spawnSpy);
    const { uploadGeneratedVideoFromUrl } = await import('../src/lib/storage');
    const result = await uploadGeneratedVideoFromUrl({
      userId: 'u',
      jobId: 'j',
      remoteUrl: 'https://kie.ai/out.mp4',
      filename: 'v',
      // compress omitted intentionally
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(result.wasCompressed).toBe(false);
    expect(result.sizeBytes).toBe(RAW_BYTES.byteLength);
    expect(result.originalBytes).toBe(RAW_BYTES.byteLength);
    expect(result.compressionError).toBeUndefined();
    compressModule.__setFfmpegSpawnImplForTests(undefined);
  });

  it('regression pin: compress runs BEFORE Supabase upload (order-of-operations)', async () => {
    // Inject a spawner that fails the test if the storage upload
    // has already fired — proves compression precedes upload.
    const events: string[] = [];
    uploadSpy.mockImplementation(async () => {
      events.push('upload');
      return { error: null };
    });
    const { __setFfmpegSpawnImplForTests } = await import('../src/lib/video-compress');
    __setFfmpegSpawnImplForTests(async (_binary, args) => {
      events.push('compress');
      const outputPath = args[args.length - 1]!;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, COMPRESSED_BYTES);
      return { ok: true, exitCode: 0 };
    });
    const { uploadGeneratedVideoFromUrl } = await import('../src/lib/storage');
    await uploadGeneratedVideoFromUrl({
      userId: 'u',
      jobId: 'j',
      remoteUrl: 'https://hedra/output.mp4',
      filename: 'v',
      compress: true,
    });
    expect(events).toEqual(['compress', 'upload']);
    __setFfmpegSpawnImplForTests(undefined);
  });
});
