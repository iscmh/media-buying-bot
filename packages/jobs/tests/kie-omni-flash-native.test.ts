/**
 * Polish-12: Gemini Omni Flash worker — pure helper coverage.
 *   - buildContinuousMonologue: clip.dialogue join order, body-quote
 *     fallback, dedupe, empty-input handling.
 *   - buildOmniFlashPrompt: KIE_OMNI_FLASH_HARD_DIRECTIVE prepended;
 *     scrubbed character / scene; dialogue concatenated into one
 *     continuous-monologue block; pacing instruction includes
 *     duration; three-view character sheet directive stripped;
 *     caption / b-roll language stripped.
 *
 * The Inngest function itself is integration-tested via the Inngest
 * dashboard — these tests cover the prompt math.
 */
import { describe, expect, it } from 'vitest';
import {
  buildContinuousMonologue,
  buildOmniFlashPrompt,
} from '../src/functions/generate-kie-omni-flash-native';

describe('Polish-12: buildContinuousMonologue', () => {
  const mk = (overrides: Partial<{ videoPrompt: string; dialogue: string }>) => ({
    videoPrompt: overrides.videoPrompt ?? 'Body.',
    dialogue: overrides.dialogue,
  });

  it('joins clip.dialogue values in order, each wrapped in quotes', () => {
    const out = buildContinuousMonologue([
      mk({ dialogue: 'Hi there.' }),
      mk({ dialogue: 'I tried this product.' }),
      mk({ dialogue: 'Click below.' }),
    ]);
    expect(out).toBe('"Hi there." "I tried this product." "Click below."');
  });

  it('falls back to quoted-string match on the scrubbed body when clip.dialogue is missing', () => {
    const out = buildContinuousMonologue([
      mk({
        videoPrompt:
          'Static iPhone shot. [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "Morning!" Smile.',
      }),
    ]);
    expect(out).toBe('"Morning!"');
  });

  it('dedupes consecutive identical dialogue lines (parser + body echo)', () => {
    const out = buildContinuousMonologue([
      mk({ dialogue: 'Same line.' }),
      mk({ dialogue: 'Same line.' }),
      mk({ dialogue: 'Different.' }),
    ]);
    expect(out).toBe('"Same line." "Different."');
  });

  it('skips clips with no extractable dialogue', () => {
    const out = buildContinuousMonologue([
      mk({ dialogue: 'Hi.' }),
      mk({ videoPrompt: 'B-roll only.' }),
      mk({ dialogue: 'Bye.' }),
    ]);
    expect(out).toBe('"Hi." "Bye."');
  });

  it('returns empty string when no clip carries dialogue', () => {
    expect(buildContinuousMonologue([mk({ videoPrompt: 'b-roll' })])).toBe('');
    expect(buildContinuousMonologue([])).toBe('');
  });
});

describe('Polish-12: buildOmniFlashPrompt', () => {
  const manual = {
    characterPrompt:
      'Photorealistic three-view character sheet, front view, side view, back view. A 30yo woman with dark hair, wearing a blue cotton t-shirt. Lower-third caption shows her name.',
    setPrompt: 'Sunny morning kitchen. B-roll cutaway to coffee beans appears occasionally.',
    clips: [
      { videoPrompt: 'Hold mug.', dialogue: 'Hi, I want to talk about my morning routine.' },
      { videoPrompt: 'Sip coffee.', dialogue: 'This product changed my life.' },
    ],
  };

  it('prepends KIE_OMNI_FLASH_HARD_DIRECTIVE first', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out.startsWith('ABSOLUTE REQUIREMENTS')).toBe(true);
    expect(out).toMatch(/AMATEUR SMARTPHONE SELFIE VIDEO/);
    expect(out).toMatch(/ABSOLUTELY NO: captions/);
    expect(out).toMatch(/ABSOLUTELY NO: cinematic lighting/);
  });

  it('strips the three-view character sheet directive', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out).not.toMatch(/three[\s-]view character sheet/i);
  });

  it('strips caption / b-roll language from user-supplied character + scene', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out).not.toMatch(/Lower-third caption shows her name/i);
    expect(out).not.toMatch(/B-roll cutaway to coffee beans/i);
  });

  it('preserves the surviving character + scene content', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out).toMatch(/30yo woman/);
    expect(out).toMatch(/blue cotton t-shirt/);
    expect(out).toMatch(/Sunny morning kitchen/);
  });

  it('concatenates dialogues into one continuous-monologue block', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out).toMatch(
      /DIALOGUE \(the character delivers this as one continuous spoken monologue\)/,
    );
    expect(out).toMatch(/"Hi, I want to talk about my morning routine\."/);
    expect(out).toMatch(/"This product changed my life\."/);
  });

  it('reports the actual duration in the pacing block', () => {
    const out10 = buildOmniFlashPrompt(manual, 10);
    expect(out10).toMatch(/10-second duration/);
    const out6 = buildOmniFlashPrompt(manual, 6);
    expect(out6).toMatch(/6-second duration/);
  });

  it('falls back to natural-ambient when no clip carries dialogue', () => {
    const out = buildOmniFlashPrompt(
      {
        characterPrompt: 'A 30yo woman.',
        setPrompt: 'A sunny kitchen.',
        clips: [{ videoPrompt: 'b-roll only', dialogue: undefined }],
      },
      10,
    );
    expect(out).toMatch(/No dialogue — natural ambient sound only/);
  });

  it('emits a single CHARACTER + SCENE block per call (no duplicates)', () => {
    const out = buildOmniFlashPrompt(manual, 10);
    expect(out.match(/^CHARACTER:/gm)).toHaveLength(1);
    expect(out.match(/^SCENE \/ SET:/gm)).toHaveLength(1);
  });
});
