/**
 * Phase 3h: Gemini Files API + size-based routing.
 *
 * Coverage:
 *   - Routes ≤ 20 MB to inline path (one POST, no upload/delete calls).
 *   - Routes 20 MB–2 GB to Files API: upload → poll → generateContent →
 *     delete (in that order).
 *   - Rejects > 2 GB fast with no API calls.
 *   - Polling: PROCESSING repeats until ACTIVE.
 *   - Polling: FAILED state returns ok=false.
 *   - Upload failure: returns helpful "compress" message + skips downstream.
 *   - Cleanup runs even when generateContent errors.
 *
 * Mocks global fetch with a URL-based router so we can verify ordering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import {
  callGeminiVision,
  deleteGeminiFile,
  pollGeminiFileReady,
  uploadGeminiFile,
} from '../src/gemini-client';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

interface FetchRecord {
  url: string;
  method: string;
  contentType?: string;
}

function setupFetchRouter(opts: {
  generatePayload?: unknown;
  uploadResponse?: { status?: number; body: unknown };
  /** Sequence of state values returned by GET /files/* (cycles to ACTIVE last). */
  pollSequence?: Array<{ status?: number; state?: string }>;
  /** Override DELETE response (default 200). */
  deleteStatus?: number;
}): FetchRecord[] {
  const records: FetchRecord[] = [];
  let pollIdx = 0;

  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers as Record<string, string> | undefined;
    const contentType = headers?.['content-type'] ?? headers?.['Content-Type'];
    records.push({ url, method, contentType });

    // Upload endpoint: POST /upload/v1beta/files
    if (url.includes('/upload/v1beta/files')) {
      const resp = opts.uploadResponse ?? {
        body: { file: { name: 'files/abc123', uri: 'https://gemini/files/abc123' } },
      };
      return {
        ok: (resp.status ?? 200) < 400,
        status: resp.status ?? 200,
        text: async () => JSON.stringify(resp.body),
        json: async () => resp.body,
      } as Response;
    }

    // Delete endpoint: DELETE /v1beta/files/abc123
    if (method === 'DELETE' && url.includes('/v1beta/files/')) {
      const status = opts.deleteStatus ?? 200;
      return {
        ok: status < 400,
        status,
        text: async () => '',
      } as Response;
    }

    // Poll endpoint: GET /v1beta/files/abc123
    if (method === 'GET' && url.includes('/v1beta/files/')) {
      const seq = opts.pollSequence ?? [{ state: 'ACTIVE' }];
      const item = seq[Math.min(pollIdx, seq.length - 1)]!;
      pollIdx++;
      const status = item.status ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () => ({ name: 'files/abc123', state: item.state ?? 'ACTIVE' }),
        text: async () => JSON.stringify({ state: item.state ?? 'ACTIVE' }),
      } as Response;
    }

    // generateContent
    if (url.includes(':generateContent')) {
      const body = opts.generatePayload ?? {
        candidates: [{ content: { parts: [{ text: '{"persona":"young female"}' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      } as Response;
    }

    throw new Error(`Unrouted fetch in test: ${method} ${url}`);
  }) as typeof globalThis.fetch;

  return records;
}

/** Build a base64 string that decodes to ~N bytes (rounded by base64 padding). */
function fakeBase64(bytes: number): string {
  // 3 bytes of binary → 4 chars of base64. Padding adjustments are negligible
  // for the size routing check (it uses floor(len*3/4)).
  const chars = Math.ceil((bytes * 4) / 3);
  return 'A'.repeat(chars);
}

describe('callGeminiVision routing', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('uses the inline path for videos ≤ 20 MB (one POST, no upload/delete)', async () => {
    const records = setupFetchRouter({});

    const result = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: fakeBase64(10 * 1024 * 1024), // 10 MB
      videoMimeType: 'video/mp4',
    });

    expect(result.ok).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]!.url).toMatch(/:generateContent$/);
    expect(records[0]!.method).toBe('POST');
  });

  it('uses the Files API for videos > 20 MB: upload → poll → generate → delete', async () => {
    const records = setupFetchRouter({
      pollSequence: [{ state: 'PROCESSING' }, { state: 'ACTIVE' }],
    });

    const result = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: fakeBase64(50 * 1024 * 1024), // 50 MB
      videoMimeType: 'video/mp4',
    });

    expect(result.ok).toBe(true);

    // Cleanup runs asynchronously after the generateContent return; wait
    // a tick so the void-Promise lands before assertions.
    await new Promise((resolve) => setImmediate(resolve));

    const ops = records.map((r) => `${r.method} ${urlKind(r.url)}`);
    // Expected order: UPLOAD → POLL × 2 → GENERATE → DELETE.
    expect(ops[0]).toBe('POST upload');
    expect(ops.filter((s) => s === 'GET file').length).toBe(2);
    expect(ops).toContain('POST generate');
    expect(ops).toContain('DELETE file');
    // Generate must come BEFORE delete.
    expect(ops.indexOf('POST generate')).toBeLessThan(ops.lastIndexOf('DELETE file'));
  });

  it('rejects > 2 GB without any fetch calls', async () => {
    const records = setupFetchRouter({});
    // Can't physically allocate a 2 GB string — V8 string max is ~512 MB.
    // The size check only reads .length, so a string-like object suffices.
    const oversize = {
      length: Math.ceil((3 * 1024 * 1024 * 1024 * 4) / 3),
    } as unknown as string;
    const result = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: oversize,
      videoMimeType: 'video/mp4',
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/2 GB/);
    expect(records).toHaveLength(0);
  });

  it('still deletes the uploaded file when generateContent errors', async () => {
    const records = setupFetchRouter({
      pollSequence: [{ state: 'ACTIVE' }],
    });
    // Override the generate route to return an error body.
    const baseRouter = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes(':generateContent')) {
        records.push({ url, method: 'POST' });
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: { message: 'transient server error' } }),
        } as Response;
      }
      return (baseRouter as unknown as (url: string, init?: RequestInit) => Promise<Response>)(
        url,
        init,
      );
    }) as typeof globalThis.fetch;

    const result = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: fakeBase64(50 * 1024 * 1024),
      videoMimeType: 'video/mp4',
    });

    expect(result.ok).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));

    const ops = records.map((r) => `${r.method} ${urlKind(r.url)}`);
    expect(ops).toContain('DELETE file'); // cleanup still ran
  });
});

describe('uploadGeminiFile', () => {
  it('returns the file name + uri on a 200 response', async () => {
    setupFetchRouter({});
    const r = await uploadGeminiFile({
      userId: 'u',
      apiKey: 'k',
      fileBuffer: Buffer.from('test bytes'),
      mimeType: 'video/mp4',
    });
    expect(r.ok).toBe(true);
    expect(r.fileName).toBe('files/abc123');
    expect(r.fileUri).toBe('https://gemini/files/abc123');
  });

  it('surfaces the Gemini error message on 4xx', async () => {
    setupFetchRouter({
      uploadResponse: { status: 400, body: { error: { message: 'invalid mime type' } } },
    });
    const r = await uploadGeminiFile({
      userId: 'u',
      apiKey: 'k',
      fileBuffer: Buffer.from('x'),
      mimeType: 'video/mp4',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/invalid mime type/);
  });

  it('callGeminiVision surfaces the upload error with a "compress" hint', async () => {
    setupFetchRouter({
      uploadResponse: { status: 413, body: { error: { message: 'too large' } } },
    });
    const r = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: fakeBase64(50 * 1024 * 1024),
      videoMimeType: 'video/mp4',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/compress/i);
    expect(r.errorMessage).toMatch(/too large/);
  });
});

describe('pollGeminiFileReady', () => {
  it('resolves ACTIVE after a few PROCESSING ticks', async () => {
    setupFetchRouter({
      pollSequence: [{ state: 'PROCESSING' }, { state: 'PROCESSING' }, { state: 'ACTIVE' }],
    });
    const r = await pollGeminiFileReady({
      userId: 'u',
      apiKey: 'k',
      fileName: 'files/abc123',
      timeoutMs: 30_000,
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('ACTIVE');
  }, 30_000);

  it('returns ok=false when state goes FAILED', async () => {
    setupFetchRouter({
      pollSequence: [{ state: 'FAILED' }],
    });
    const r = await pollGeminiFileReady({
      userId: 'u',
      apiKey: 'k',
      fileName: 'files/abc123',
      timeoutMs: 30_000,
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('FAILED');
  });

  it('returns ok=false on poll timeout', async () => {
    setupFetchRouter({
      // Always returns PROCESSING — exhausts the budget.
      pollSequence: [{ state: 'PROCESSING' }],
    });
    const r = await pollGeminiFileReady({
      userId: 'u',
      apiKey: 'k',
      fileName: 'files/abc123',
      // Very short budget so the test completes quickly.
      timeoutMs: 50,
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/did not complete/i);
  });
});

describe('deleteGeminiFile', () => {
  it('returns ok=true on 200', async () => {
    setupFetchRouter({});
    const r = await deleteGeminiFile({ userId: 'u', apiKey: 'k', fileName: 'files/abc123' });
    expect(r.ok).toBe(true);
  });

  it('treats 404 as success (already gone)', async () => {
    setupFetchRouter({ deleteStatus: 404 });
    const r = await deleteGeminiFile({ userId: 'u', apiKey: 'k', fileName: 'files/abc123' });
    expect(r.ok).toBe(true);
  });

  it('returns ok=false on 5xx', async () => {
    setupFetchRouter({ deleteStatus: 500 });
    const r = await deleteGeminiFile({ userId: 'u', apiKey: 'k', fileName: 'files/abc123' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/HTTP 500/);
  });
});

function urlKind(url: string): 'upload' | 'poll' | 'generate' | 'file' | 'other' {
  if (url.includes('/upload/v1beta/files')) return 'upload';
  if (url.includes(':generateContent')) return 'generate';
  if (url.includes('/v1beta/files/')) {
    // Cleanup path uses the same URL as poll; the method disambiguates at the caller.
    return 'file';
  }
  return 'other';
}
