import { describe, expect, it } from 'vitest';
import { classifyGeminiUploadError, describeGeminiUploadError } from '../src/gemini-client';

/**
 * Polish-25.8 Commit 54 tripwire: the exact string a tester saw
 * ("Your project has been denied access. Please contact support.")
 * must classify as denied_access, NOT as too_large. A regex tweak
 * that misroutes it will fail this pin so the wrong-advice regression
 * gets caught in CI.
 */

describe('classifyGeminiUploadError', () => {
  it('denied-access text from Google routes to denied_access', () => {
    const { category, actionableHint } = classifyGeminiUploadError(
      'Your project has been denied access. Please contact support.',
    );
    expect(category).toBe('denied_access');
    expect(actionableHint).toMatch(/generativelanguage\.googleapis\.com/);
    expect(actionableHint).not.toMatch(/compress/i);
  });

  it('PERMISSION_DENIED gRPC-style error routes to denied_access', () => {
    expect(
      classifyGeminiUploadError('PERMISSION_DENIED: The caller does not have permission').category,
    ).toBe('denied_access');
  });

  it('429 / RESOURCE_EXHAUSTED / "rate limit" text routes to quota', () => {
    expect(classifyGeminiUploadError('HTTP 429: too many requests').category).toBe('quota');
    expect(classifyGeminiUploadError('RESOURCE_EXHAUSTED: quota exceeded').category).toBe('quota');
    expect(classifyGeminiUploadError('rate limit reached').category).toBe('quota');
  });

  it('size limit language routes to too_large', () => {
    expect(classifyGeminiUploadError('Payload too large').category).toBe('too_large');
    expect(classifyGeminiUploadError('HTTP 413: request exceeds maximum').category).toBe(
      'too_large',
    );
  });

  it('unknown error surfaces the "other" bucket without misleading advice', () => {
    const { category, actionableHint } = classifyGeminiUploadError('Some unexpected error');
    expect(category).toBe('other');
    expect(actionableHint).not.toMatch(/compress/i);
    expect(actionableHint).not.toMatch(/console\.cloud\.google\.com/);
  });

  it('describeGeminiUploadError preserves the raw error for greppability', () => {
    const raw = 'Your project has been denied access. Please contact support.';
    const described = describeGeminiUploadError(raw);
    expect(described).toContain(raw);
    expect(described).toMatch(/generativelanguage\.googleapis\.com/);
  });
});
