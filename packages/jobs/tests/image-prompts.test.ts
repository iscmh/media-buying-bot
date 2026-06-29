/**
 * Polish-19.0.4: tests for the shared image-prompts helpers extracted
 * from generate-kling-multi-clip-variants.ts. Pins the directives the
 * Polish-9.x → 12.x iteration tuned into existence (anti-text,
 * amateur-selfie realism) AND pins the deliberate scope cut for the
 * Kling Avatar pipeline (single-line anti-celeb, NOT the long
 * Polish-12.6 exclusion list).
 */
import { describe, expect, it } from 'vitest';
import {
  IMAGE_UGC_HARD_DIRECTIVE,
  KLING_AVATAR_ANTI_CELEB_LINE,
  UGC_FRAMING,
  buildKlingAvatarReferencePrompt,
} from '../src/lib/image-prompts';

describe('Polish-19.0.4: IMAGE_UGC_HARD_DIRECTIVE content (back-compat with Polish-11.2)', () => {
  it('still covers the anti-text directives Polish-11.2 added', () => {
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/ABSOLUTELY NO TEXT/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO captions/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO subtitles/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO watermarks/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO logos/);
  });

  it('still covers the anti-b-roll directives', () => {
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO B-roll inset/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO picture-in-picture/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/NO insert shots/);
  });

  it('still covers the UGC realism cues', () => {
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/AMATEUR SMARTPHONE SELFIE/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/PHOTOREALISTIC/);
    expect(IMAGE_UGC_HARD_DIRECTIVE).toMatch(/Real human skin texture/);
  });
});

describe('Polish-19.0.4: UGC_FRAMING content (back-compat with Polish-9.18)', () => {
  it('covers iPhone-front-camera amateur-selfie framing', () => {
    expect(UGC_FRAMING).toMatch(/AMATEUR SMARTPHONE SELFIE/);
    expect(UGC_FRAMING).toMatch(/iPhone front camera/);
    expect(UGC_FRAMING).toMatch(/handheld/);
  });

  it('covers hyper-real skin / hair / eye texture cues', () => {
    expect(UGC_FRAMING).toMatch(/hyper-realistic pores/);
    expect(UGC_FRAMING).toMatch(/NOT smooth/);
    expect(UGC_FRAMING).toMatch(/NOT airbrushed/);
    expect(UGC_FRAMING).toMatch(/symmetric AI eyes/);
  });

  it('explicitly rules out studio/professional photography', () => {
    expect(UGC_FRAMING).toMatch(/NOT professional photography/);
    expect(UGC_FRAMING).toMatch(/NOT studio lighting/);
    expect(UGC_FRAMING).toMatch(/NOT a stock photo/);
    expect(UGC_FRAMING).toMatch(/NOT a soundstage/);
  });
});

describe('Polish-19.0.4: buildKlingAvatarReferencePrompt', () => {
  it('embeds the Polish-11.2 anti-text directive', () => {
    const out = buildKlingAvatarReferencePrompt();
    expect(out).toContain(IMAGE_UGC_HARD_DIRECTIVE);
    expect(out).toMatch(/ABSOLUTELY NO TEXT/);
  });

  it('embeds the Polish-9.18 amateur-selfie framing', () => {
    const out = buildKlingAvatarReferencePrompt();
    expect(out).toContain(UGC_FRAMING);
    expect(out).toMatch(/AMATEUR SMARTPHONE SELFIE/);
    expect(out).toMatch(/hyper-realistic pores/);
  });

  it('embeds the single-line anti-celeb guidance (KLING_AVATAR_ANTI_CELEB_LINE)', () => {
    const out = buildKlingAvatarReferencePrompt();
    expect(out).toContain(KLING_AVATAR_ANTI_CELEB_LINE);
    expect(out).toMatch(/fictional/i);
    expect(out).toMatch(/no resemblance/i);
  });

  it('does NOT include the long Polish-12.6 celebrity exclusion list (deliberate scope cut)', () => {
    // Per Commit 1 spec — Kling Avatar v2 animates a provided face,
    // so the laundry-list anti-celeb directive isn't needed. This
    // assertion is a tripwire: if a future cleanup tries to "fix"
    // the missing list, it fails here first.
    const out = buildKlingAvatarReferencePrompt();
    expect(out).not.toMatch(/Brad Pitt/);
    expect(out).not.toMatch(/Tom Cruise/);
    expect(out).not.toMatch(/Taylor Swift/);
    expect(out).not.toMatch(/Donald Trump/);
    expect(out).not.toMatch(/Barack Obama/);
    expect(out).not.toMatch(/LeBron James/);
    expect(out).not.toMatch(/Kim Kardashian/);
    expect(out).not.toMatch(/MrBeast/);
  });

  it('contains the single-frame / single-camera-angle constraint', () => {
    const out = buildKlingAvatarReferencePrompt();
    expect(out).toMatch(/ONE single frame/);
    expect(out).toMatch(/ONE camera angle/);
    expect(out).toMatch(/NOT a reference sheet/);
  });

  it('uses the generic everyperson stub when no characterDescription is passed', () => {
    const out = buildKlingAvatarReferencePrompt();
    expect(out).toMatch(/fictional everyday person/i);
  });

  it('uses the provided characterDescription verbatim when supplied', () => {
    const out = buildKlingAvatarReferencePrompt({
      characterDescription: '34yo barista with curly brown hair, denim apron',
    });
    expect(out).toContain('34yo barista with curly brown hair, denim apron');
  });

  it('falls back to the generic stub on an empty / whitespace-only characterDescription', () => {
    expect(buildKlingAvatarReferencePrompt({ characterDescription: '' })).toMatch(
      /fictional everyday person/i,
    );
    expect(buildKlingAvatarReferencePrompt({ characterDescription: '   ' })).toMatch(
      /fictional everyday person/i,
    );
  });
});
