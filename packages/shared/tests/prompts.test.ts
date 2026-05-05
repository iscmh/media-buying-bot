/**
 * Verify the four operator prompts are present, non-empty, and reasonable
 * length. The actual content is operator-tuned text — we don't assert on
 * specific words because spec edits would break the test, but we DO assert
 * on minimum length so accidental truncation in a copy/paste is caught.
 */
import { describe, expect, it } from 'vitest';
import {
  NANO_BANANA_CLONING_PROMPT_TEMPLATE,
  SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
  STATIC_WINNER_IMPORT_SYSTEM_PROMPT,
  UGC_DECONSTRUCTOR_SYSTEM_PROMPT,
} from '../src';

describe('operator prompts', () => {
  it('UGC_DECONSTRUCTOR_SYSTEM_PROMPT is non-empty and substantial', () => {
    expect(typeof UGC_DECONSTRUCTOR_SYSTEM_PROMPT).toBe('string');
    expect(UGC_DECONSTRUCTOR_SYSTEM_PROMPT.length).toBeGreaterThan(2000);
    expect(UGC_DECONSTRUCTOR_SYSTEM_PROMPT).toContain('UGC Video Deconstructor');
    expect(UGC_DECONSTRUCTOR_SYSTEM_PROMPT).toContain('Output ONLY valid JSON');
  });

  it('SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT is non-empty and substantial', () => {
    expect(SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT.length).toBeGreaterThan(2000);
    expect(SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT).toContain('Sora 2 prompt engineer');
    expect(SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT).toContain('intensity');
    expect(SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT).toContain('variant_count');
  });

  it('STATIC_WINNER_IMPORT_SYSTEM_PROMPT is non-empty and substantial', () => {
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT.length).toBeGreaterThan(2000);
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toContain('media buyer');
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toContain('Meta Ads');
  });

  it('NANO_BANANA_CLONING_PROMPT_TEMPLATE is non-empty and substantial', () => {
    expect(NANO_BANANA_CLONING_PROMPT_TEMPLATE.length).toBeGreaterThan(2000);
    expect(NANO_BANANA_CLONING_PROMPT_TEMPLATE).toContain('photo-realistic');
    expect(NANO_BANANA_CLONING_PROMPT_TEMPLATE).toContain('output_format');
  });

  it('all four prompts include the intensity definitions where required', () => {
    // The two Claude-driven prompts need intensity definitions.
    expect(SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT).toContain('small');
    expect(SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT).toContain('medium');
    expect(SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT).toContain('big');
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toContain('small');
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toContain('medium');
    expect(STATIC_WINNER_IMPORT_SYSTEM_PROMPT).toContain('big');
  });
});
