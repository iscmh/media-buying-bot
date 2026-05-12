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
