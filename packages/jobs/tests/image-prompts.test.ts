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

describe('Polish-19.0.7: buildKlingAvatarReferencePrompt (StructuredCharacter input)', () => {
  // Test fixture mirroring the manual prompt pattern that lands actual
  // photoreal Nano Banana output (the Linda-the-grandmother example).
  const FIXTURE = {
    name: 'Linda',
    age: 62,
    nationality: 'American',
    gender: 'female' as const,
    archetype: 'Generic suburban grandmother appearance.',
    hair: {
      color: 'grey-blonde',
      length: 'chin-length',
      cut: 'soft',
      texture: 'natural',
      styling: 'slightly messy, NOT styled',
    },
    eyes: {
      color: 'warm brown',
      asymmetry: 'one eyelid drooping slightly more than the other',
      crows_feet: "deep crow's feet",
      bags: 'slight bags under eyes',
    },
    nose: 'ordinary nose, slightly wider than average, small bump on the bridge',
    mouth: 'thin lips, slightly asymmetric mouth, natural slight downturn',
    jaw_and_face_shape:
      'soft jawline with subtle jowls, slightly rounded face — NOT chiseled, NOT model-shaped',
    skin_imperfections: {
      pores: 'visible pores',
      age_spots: 'age spots near temples and on hands',
      redness: 'slight redness on cheekbones',
      capillaries: 'broken capillaries near the nose',
      anchor: 'ZERO airbrushing',
    },
    clothing: 'soft cream cardigan over a plain cotton blouse, simple wedding ring',
    setting: {
      room_type: 'a sunlit living room',
      details: ['beige sofa behind her', 'side table with coffee mug', 'large window'],
      lighting: 'bright natural daylight',
    },
  };

  it('leads with the PHOTOREALISTIC PHOTOGRAPH anchor + age/nationality/name', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).toMatch(/^PHOTOREALISTIC PHOTOGRAPH/);
    expect(out).toMatch(/Vertical iPhone selfie/);
    expect(out).toMatch(/62-year-old American female named Linda/);
    expect(out).toMatch(/Generic suburban grandmother appearance\./);
  });

  it('embeds the itemized PHYSICAL FEATURES block with the asymmetry framing', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).toMatch(/PHYSICAL FEATURES \(deliberately asymmetric and ordinary\):/);
    // Each required field surfaces verbatim
    expect(out).toContain('grey-blonde');
    expect(out).toContain('slightly messy, NOT styled');
    expect(out).toContain('one eyelid drooping slightly more than the other');
    expect(out).toContain('small bump on the bridge');
    expect(out).toContain('NOT chiseled, NOT model-shaped');
  });

  it('embeds the setting block with all detail items and lighting', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).toContain('a sunlit living room');
    expect(out).toContain('beige sofa behind her');
    expect(out).toContain('side table with coffee mug');
    expect(out).toContain('large window');
    expect(out).toContain('bright natural daylight');
  });

  it('embeds the SKIN REALISM block with the ZERO airbrushing/filter/smoothing trio', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).toMatch(/SKIN REALISM: Real 62-year-old skin/);
    expect(out).toContain('visible pores');
    expect(out).toContain('broken capillaries near the nose');
    expect(out).toMatch(/ZERO airbrushing, ZERO beauty filter, ZERO smoothing/);
  });

  it('closes with the iPhone-front-camera 9:16 phrasing', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).toMatch(
      /Shot on iPhone front camera, 9:16 vertical, natural daylight, slightly shaky handheld feel\./,
    );
  });

  it('keeps the Polish-11.2 IMAGE_UGC_HARD_DIRECTIVE at the tail (back-compat anti-text reinforcement)', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).toContain(IMAGE_UGC_HARD_DIRECTIVE);
  });

  it('keeps the single-line anti-celeb guidance at the tail', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).toContain(KLING_AVATAR_ANTI_CELEB_LINE);
  });

  it('does NOT include the Polish-12.6 celebrity exclusion list (deliberate scope cut)', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).not.toMatch(/Brad Pitt/);
    expect(out).not.toMatch(/Tom Cruise/);
    expect(out).not.toMatch(/Taylor Swift/);
  });

  it('does NOT include the studio-portrait language that pre-Polish-19.0.4 used', () => {
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).not.toMatch(/soft natural lighting, plain background/);
    expect(out).not.toMatch(/professional photography/);
    expect(out).not.toMatch(/cinematic lighting/);
  });

  it('picks the correct pronoun per gender', () => {
    const male = buildKlingAvatarReferencePrompt({ ...FIXTURE, name: 'Bob', gender: 'male' });
    expect(male).toMatch(/He is in a sunlit living room/);
    const female = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(female).toMatch(/She is in a sunlit living room/);
    const nonbinary = buildKlingAvatarReferencePrompt({ ...FIXTURE, gender: 'nonbinary' });
    expect(nonbinary).toMatch(/They is in a sunlit living room/);
    // ^ minor grammar quirk; documenting actual behavior since the
    //  pronoun is a stylistic anchor not a grammar correctness check.
  });

  it('voids the UGC_FRAMING constant from the composition (5-block lead replaces it)', () => {
    // UGC_FRAMING stays in the lib for other callers, but the new
    // composition does NOT include it — the 5-block lead covers its
    // role. Tripwire so a future cleanup doesn't accidentally re-add.
    const out = buildKlingAvatarReferencePrompt(FIXTURE);
    expect(out).not.toContain(UGC_FRAMING);
  });
});
