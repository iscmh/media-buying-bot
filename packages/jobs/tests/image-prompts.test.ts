/**
 * Polish-19.0.4 → Polish-20 Commit 5: tests for the shared image-
 * prompts helpers. Pins the directives the Polish-9.x → 12.x
 * iteration tuned into existence (anti-text, amateur-selfie realism)
 * for reuse by any Polish-21+ reference-image mode on the unified
 * video-variant worker.
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

describe('Polish-19.0.8: buildKlingAvatarReferencePrompt (JOHN-pattern StructuredCharacter)', () => {
  // The fixture below mirrors the production-confirmed JOHN pattern
  // that reliably lands photoreal output. Every assertion below pins
  // a specific element of that pattern — anything Nano Banana relies
  // on for "casting-director reference" framing rather than "AI
  // portrait" stays here as a tripwire.
  const JOHN = {
    name: 'John',
    age: 64,
    nationality: 'American',
    gender: 'male' as const,
    hair_description: 'Short, neatly side-combed grey hair, slightly thinning at the temples.',
    face_description:
      'Soft jowls just beginning to form along his jawline, deep laugh lines bracketing his ' +
      'mouth, scattered age spots across his cheekbones. Warm brown eyes with genuine crinkle ' +
      'lines from years of squinting in the sun.',
    body_posture_clothing:
      'Medium build, slightly rounded shoulders suggesting a life of desk work, not athletic. ' +
      'Wearing a casual olive-green long-sleeved cotton shirt, slightly worn at the collar — ' +
      'not new, not dirty. Relaxed posture, leaning very slightly forward, the posture of a ' +
      'man used to sitting on a sofa and talking to family.',
    skin_color_for_stubble: 'grey' as const,
    role_description: 'grandfather',
    setting_description:
      'Sitting on a beige sofa in a sunlit living room — a side table with a coffee mug to ' +
      'his left, family photos on the wall behind him, natural daylight pouring in from a ' +
      'large bay window.',
  };

  it('leads with the THREE-VIEW character-sheet framing + name UPPERCASE + age/nationality', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toMatch(
      /^Photorealistic three-view character sheet — front view, side view, back view — of a 64-year-old American man named JOHN\./,
    );
  });

  it('embeds the naturalistic hair + face paragraph (NOT itemized bullets)', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toContain('Short, neatly side-combed grey hair, slightly thinning at the temples.');
    expect(out).toContain('Soft jowls just beginning to form along his jawline');
    expect(out).toContain('Warm brown eyes with genuine crinkle lines');
    // Tripwire — the old itemized "- Hair: …\n- Eyes: …" bullet
    // composition must not return.
    expect(out).not.toMatch(/^- Hair:/m);
    expect(out).not.toMatch(/^- Eyes:/m);
    expect(out).not.toMatch(/PHYSICAL FEATURES \(deliberately asymmetric and ordinary\)/);
  });

  it('embeds the body / posture / clothing paragraph with the worn-collar lived-in cue', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toContain('slightly rounded shoulders suggesting a life of desk work');
    expect(out).toContain('slightly worn at the collar — not new, not dirty');
    expect(out).toContain('posture of a man used to sitting on a sofa');
  });

  it('embeds the SKIN REALISM MANDATE with the exact three ZERO anchors in order', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toMatch(/SKIN REALISM MANDATE: Hyper-realistic unedited human skin\./);
    expect(out).toContain('Visible pores, natural sebaceous texture on nose.');
    // All three ZEROs — including the critical "ZERO AI plastic-skin
    // artifacts" that explicitly fights the model's default aesthetic.
    expect(out).toContain('ZERO beauty filters.');
    expect(out).toContain('ZERO skin smoothing.');
    expect(out).toContain('ZERO AI plastic-skin artifacts.');
  });

  it('embeds the stubble line when skin_color_for_stubble != "none"', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toContain(
      'Real grey stubble shadow on upper lip and jaw from one day of missed shaving.',
    );
  });

  it('omits the stubble line when skin_color_for_stubble = "none" (women / clean-shaven / kids)', () => {
    const linda = {
      ...JOHN,
      name: 'Linda',
      gender: 'female' as const,
      skin_color_for_stubble: 'none' as const,
      role_description: 'grandmother',
    };
    const out = buildKlingAvatarReferencePrompt(linda);
    expect(out).not.toMatch(/stubble shadow/i);
    expect(out).not.toMatch(/missed shaving/i);
  });

  it('closes the SKIN REALISM MANDATE with the explicit role identity assertion', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toMatch(
      /He must look like a real 64-year-old grandfather, not a model, not an actor, not an AI-generated character\./,
    );
  });

  it('embeds the camera + setting close line', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toMatch(
      /Shot on iPhone front camera, 9:16 vertical, natural daylight, slightly shaky handheld feel\./,
    );
    expect(out).toContain('Sitting on a beige sofa in a sunlit living room');
    expect(out).toContain('large bay window');
  });

  it('keeps the Polish-11.2 IMAGE_UGC_HARD_DIRECTIVE at the tail', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toContain(IMAGE_UGC_HARD_DIRECTIVE);
  });

  it('keeps the single-line anti-celeb guidance at the tail', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).toContain(KLING_AVATAR_ANTI_CELEB_LINE);
  });

  it('does NOT include the Polish-12.6 celebrity exclusion list (deliberate scope cut)', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).not.toMatch(/Brad Pitt/);
    expect(out).not.toMatch(/Tom Cruise/);
    expect(out).not.toMatch(/Taylor Swift/);
  });

  it('does NOT include the pre-Polish-19.0.4 studio-portrait language', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).not.toMatch(/soft natural lighting, plain background/);
    expect(out).not.toMatch(/professional photography/);
    expect(out).not.toMatch(/cinematic lighting/);
  });

  it('picks the right pronoun + gender noun per gender', () => {
    expect(buildKlingAvatarReferencePrompt(JOHN)).toMatch(/American man named JOHN/);
    expect(buildKlingAvatarReferencePrompt(JOHN)).toMatch(/He must look like/);

    const female = {
      ...JOHN,
      name: 'Linda',
      gender: 'female' as const,
      role_description: 'grandmother',
    };
    expect(buildKlingAvatarReferencePrompt(female)).toMatch(/American woman named LINDA/);
    expect(buildKlingAvatarReferencePrompt(female)).toMatch(/She must look like/);

    const nonbinary = {
      ...JOHN,
      name: 'Sam',
      gender: 'nonbinary' as const,
      role_description: 'retiree',
    };
    expect(buildKlingAvatarReferencePrompt(nonbinary)).toMatch(/American person named SAM/);
    expect(buildKlingAvatarReferencePrompt(nonbinary)).toMatch(/They must look like/);
  });

  it('does NOT embed UGC_FRAMING in the composition (JOHN pattern replaces it)', () => {
    const out = buildKlingAvatarReferencePrompt(JOHN);
    expect(out).not.toContain(UGC_FRAMING);
  });
});
