/**
 * Polish-6: vision detection. Verifies format classification,
 * demographics extraction, edge cases (no frames, garbled JSON,
 * single-frame image detection).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import { detectCreativeFormat, type DetectedFormat } from '../src/vision-detection';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function mockClaudeVision(detection: Partial<DetectedFormat>, opts?: { status?: number }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    status: opts?.status ?? 200,
    text: async () =>
      JSON.stringify({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              format: detection.format ?? 'simple_ai_ugc',
              media_type: detection.mediaType ?? 'video',
              demographics: {
                age_range: detection.demographics?.ageRange ?? '25-35',
                gender: detection.demographics?.gender ?? 'female',
                ethnicity: detection.demographics?.ethnicity ?? 'unknown',
              },
              setting: detection.setting ?? 'home office',
              emotional_tone: detection.emotionalTone ?? 'enthusiastic',
              pacing: detection.pacing ?? 'single shot',
              key_visual_elements: detection.keyVisualElements ?? ['person', 'product'],
              dialogue_script: detection.dialogueScript ?? null,
              confidence: detection.confidence ?? 0.85,
            }),
          },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
  } as Response) as typeof globalThis.fetch;
}

const TINY_IMAGE = Buffer.from(
  'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64',
).toString('base64');

describe('Polish-6: detectCreativeFormat', () => {
  it('classifies a single-frame input as static_image_ad', async () => {
    mockClaudeVision({ format: 'static_image_ad', mediaType: 'image' });
    const r = await detectCreativeFormat({
      userId: 'u',
      claudeApiKey: 'k',
      frames: [{ base64: TINY_IMAGE, mediaType: 'image/png' }],
    });
    expect(r.ok).toBe(true);
    expect(r.detection?.format).toBe('static_image_ad');
    expect(r.detection?.mediaType).toBe('image');
  });

  it('classifies multi-frame with scene changes as multi_scene_with_edits', async () => {
    mockClaudeVision({
      format: 'multi_scene_with_edits',
      mediaType: 'video',
      pacing: 'fast cuts',
    });
    const r = await detectCreativeFormat({
      userId: 'u',
      claudeApiKey: 'k',
      frames: [
        { base64: TINY_IMAGE, mediaType: 'image/jpeg' },
        { base64: TINY_IMAGE, mediaType: 'image/jpeg' },
        { base64: TINY_IMAGE, mediaType: 'image/jpeg' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.detection?.format).toBe('multi_scene_with_edits');
  });

  it('includes transcript in dialogue_script if provided', async () => {
    mockClaudeVision({
      format: 'simple_ai_ugc',
      dialogueScript: 'I tried this for 30 days',
    });
    const r = await detectCreativeFormat({
      userId: 'u',
      claudeApiKey: 'k',
      frames: [{ base64: TINY_IMAGE, mediaType: 'image/jpeg' }],
      transcript: 'I tried this for 30 days',
    });
    expect(r.ok).toBe(true);
    expect(r.detection?.dialogueScript).toMatch(/30 days/);
  });

  it('returns ok=false when no frames provided', async () => {
    const r = await detectCreativeFormat({
      userId: 'u',
      claudeApiKey: 'k',
      frames: [],
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/no frames/i);
  });

  it('returns ok=false when Claude returns garbled JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({
          content: [{ type: 'text', text: 'This is not valid JSON at all' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    } as Response) as typeof globalThis.fetch;
    const r = await detectCreativeFormat({
      userId: 'u',
      claudeApiKey: 'k',
      frames: [{ base64: TINY_IMAGE, mediaType: 'image/jpeg' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/parse/i);
  });

  it('returns ok=false when Claude returns invalid format class', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                format: 'martian_holograms',
                media_type: 'video',
                demographics: {},
                key_visual_elements: [],
                confidence: 0.9,
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    } as Response) as typeof globalThis.fetch;
    const r = await detectCreativeFormat({
      userId: 'u',
      claudeApiKey: 'k',
      frames: [{ base64: TINY_IMAGE, mediaType: 'image/jpeg' }],
    });
    expect(r.ok).toBe(false);
  });

  it('extracts demographics from Claude response', async () => {
    mockClaudeVision({
      format: 'simple_ai_ugc',
      demographics: { ageRange: '20-30', gender: 'male', ethnicity: 'latino' },
    });
    const r = await detectCreativeFormat({
      userId: 'u',
      claudeApiKey: 'k',
      frames: [{ base64: TINY_IMAGE, mediaType: 'image/jpeg' }],
    });
    expect(r.ok).toBe(true);
    expect(r.detection?.demographics.ageRange).toBe('20-30');
    expect(r.detection?.demographics.gender).toBe('male');
    expect(r.detection?.demographics.ethnicity).toBe('latino');
  });

  it('returns ok=false on Claude 401', async () => {
    mockClaudeVision({ format: 'simple_ai_ugc' }, { status: 401 });
    const r = await detectCreativeFormat({
      userId: 'u',
      claudeApiKey: 'bad',
      frames: [{ base64: TINY_IMAGE, mediaType: 'image/jpeg' }],
    });
    expect(r.ok).toBe(false);
  });
});
