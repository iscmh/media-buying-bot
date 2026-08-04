import { describe, expect, it } from 'vitest';
import {
  classifyOpenaiErrorMessage as classifyOpenaiError,
  describeOpenaiError,
} from '../src/openai-image-client';

/**
 * Polish-25.9 Commit 58 tripwire: the exact tester string
 * ("Billing hard limit has been reached.") must route to
 * billing_limit + surface the Cloud-console limits URL. A regex
 * tweak that misroutes it will fail CI before the wrong-advice
 * regression ships.
 */

describe('classifyOpenaiError', () => {
  it('billing hard limit routes to billing_limit + surfaces the limits URL', () => {
    const { category, actionableHint } = classifyOpenaiError(
      'Billing hard limit has been reached.',
    );
    expect(category).toBe('billing_limit');
    expect(actionableHint).toMatch(/platform\.openai\.com\/settings\/organization\/limits/);
    expect(actionableHint).not.toMatch(/rate limit/i);
  });

  it('insufficient_quota routes to quota_exceeded + surfaces the billing URL', () => {
    expect(classifyOpenaiError('insufficient_quota: no credits').category).toBe('quota_exceeded');
    expect(
      classifyOpenaiError('You exceeded your current quota, please check your plan.').category,
    ).toBe('quota_exceeded');
    expect(classifyOpenaiError('insufficient_quota').actionableHint).toMatch(
      /platform\.openai\.com\/settings\/organization\/billing/,
    );
  });

  it('invalid API key text routes to invalid_key + surfaces the api-keys URL', () => {
    expect(classifyOpenaiError('Invalid API key provided').category).toBe('invalid_key');
    expect(classifyOpenaiError('invalid_api_key: sk-abc has been revoked').category).toBe(
      'invalid_key',
    );
    expect(classifyOpenaiError('HTTP 401: unauthorized').category).toBe('invalid_key');
    expect(classifyOpenaiError('Invalid API key').actionableHint).toMatch(
      /platform\.openai\.com\/api-keys/,
    );
  });

  it('rate-limit / 429 routes to rate_limit', () => {
    expect(classifyOpenaiError('Rate limit reached for gpt-image-2').category).toBe('rate_limit');
    expect(classifyOpenaiError('HTTP 429: too many requests').category).toBe('rate_limit');
  });

  it('content policy text routes to content_policy', () => {
    expect(classifyOpenaiError('content_policy_violation: image blocked').category).toBe(
      'content_policy',
    );
    expect(classifyOpenaiError('Our safety system rejected this prompt').category).toBe(
      'content_policy',
    );
    expect(classifyOpenaiError('Blocked by moderation filter').category).toBe('content_policy');
  });

  it('invalid image text routes to invalid_image', () => {
    expect(classifyOpenaiError('Invalid image format').category).toBe('invalid_image');
    expect(classifyOpenaiError('Corrupted image data').category).toBe('invalid_image');
    expect(classifyOpenaiError('Unsupported image type').category).toBe('invalid_image');
  });

  it('timeout / abort text routes to timeout', () => {
    expect(classifyOpenaiError('The operation was aborted due to timeout').category).toBe(
      'timeout',
    );
    expect(classifyOpenaiError('ETIMEDOUT').category).toBe('timeout');
  });

  it('unknown error surfaces "other" without a misleading URL', () => {
    const { category, actionableHint } = classifyOpenaiError('Something weird happened');
    expect(category).toBe('other');
    expect(actionableHint).not.toMatch(/platform\.openai\.com/);
  });

  it('describeOpenaiError preserves the raw error for greppability', () => {
    const raw = 'Billing hard limit has been reached.';
    const described = describeOpenaiError(raw);
    expect(described).toContain(raw);
    expect(described).toMatch(/organization\/limits/);
  });
});
