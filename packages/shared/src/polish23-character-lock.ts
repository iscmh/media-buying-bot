import { z } from 'zod';

/**
 * Polish-23 Commit 1: `character_lock` — persistent character
 * invariants written ONCE to `generation_jobs.metadata.character_lock`
 * after the Claude ad-spec step, then re-injected verbatim into
 * every per-clip Veo 3.1 Lite prompt so the character stays locked
 * across the 8 × 8s clips that compose the finished 60s ad.
 *
 * Schema mirrors the Polish-21.0.7 StructuredCharacter shape verbatim
 * — the operator explicitly asked to reuse the same field names so
 * the Polish-21 Linda-pattern Nano Banana composer can be delegated
 * to as-is when it's promoted / re-exported into the ai-providers
 * layer. Character consistency across generations comes from THIS
 * frozen record — the worker never regenerates it per-clip.
 *
 * NOT a first-class column: lives inside the existing jsonb
 * `generation_jobs.metadata` blob so no migration is needed to land
 * the schema. Polish-23 Commit 3 will read/write it inside the
 * unified worker.
 *
 * ---------------------------------------------------------------
 * Field-level notes (verbatim from Polish-21.0.7's Linda spec):
 * ---------------------------------------------------------------
 *   name / age / nationality / gender / demographic_role — top-line
 *     identity anchors. Referenced by the per-clip CHARACTER LOCK
 *     prefix: "Same {age}yo {gender} from reference…".
 *
 *   hair_bullet / eye_asymmetry_bullet / nose_bullet / mouth_bullet /
 *   eye_color_and_age_detail / jaw_bullet / face_shape_bullet /
 *   clothing_bullet — itemized bullets. Copied VERBATIM into the
 *     per-clip prompt so Veo sees identical text for the character
 *     across all 8 clips.
 *
 *   setting_paragraph — physical setting anchor. Re-emitted at each
 *     clip so background composition stays stable even when the
 *     scene action changes.
 *
 *   skin_age_appropriate_detail / skin_color_for_stubble — realism
 *     mandate anchors. Drive the three ZERO clauses (no beauty
 *     filters / no skin smoothing / no AI plastic-skin artifacts)
 *     preserved from Polish-21.0.5's original SKIN REALISM MANDATE.
 *
 *   anti_celeb_*_examples — 8-12 / 4-6 / 4-6 name lists. Steer the
 *     Higgsfield Soul reference generation away from famous-face
 *     attractors. Same directive that Polish-21.0.7 introduced.
 */

export const SKIN_COLOR_FOR_STUBBLE_VALUES = [
  'grey',
  'brown',
  'black',
  'blonde',
  'red',
  'none',
] as const;
export type SkinColorForStubble = (typeof SKIN_COLOR_FOR_STUBBLE_VALUES)[number];

export const CHARACTER_GENDER_VALUES = ['male', 'female'] as const;
export type CharacterGender = (typeof CHARACTER_GENDER_VALUES)[number];

/**
 * Polish-23 Commit 1: canonical character-lock type. Re-exported
 * from @mbb/shared so the worker (packages/jobs) + the ai-providers
 * clients + the cost estimator can all reference the same shape.
 */
export interface CharacterLock {
  name: string;
  age: number;
  nationality: string;
  gender: CharacterGender;
  /** e.g. "suburban grandmother", "working dad", "young professional". */
  demographic_role: string;
  /** Bullet — length, color, styling. Ends with "slightly messy, NOT styled" qualifier. */
  hair_bullet: string;
  /** Bullet — one specific eye-line asymmetry (e.g. droopy eyelid on one side). */
  eye_asymmetry_bullet: string;
  /** Bullet — one specific nose imperfection (bump on bridge, wider than average, etc). */
  nose_bullet: string;
  /** Bullet — mouth asymmetry / downturn detail. */
  mouth_bullet: string;
  /** Bullet — eye color + age-specific detail (crow's feet, bags, redness). */
  eye_color_and_age_detail: string;
  /** Bullet — jaw with subtle imperfection (jowls, softness, weak chin). */
  jaw_bullet: string;
  /** Bullet — face shape with "NOT chiseled, NOT model-shaped" qualifier. */
  face_shape_bullet: string;
  /** Bullet — specific clothing item + material + wear condition. */
  clothing_bullet: string;
  /** Paragraph — sitting/standing setting with specific furniture/props + light source. */
  setting_paragraph: string;
  /** String — age-appropriate skin imperfections (age spots / acne scars / freckles / etc). */
  skin_age_appropriate_detail: string;
  /** Drives the SKIN REALISM MANDATE stubble line. */
  skin_color_for_stubble: SkinColorForStubble;
  /**
   * 8-12 age-appropriate actresses the face MUST NOT resemble.
   * Named examples steer Higgsfield Soul away from the celebrity
   * attractors it defaults to.
   */
  anti_celeb_actress_examples: string[];
  /** 4-6 news anchors / talk show hosts the face MUST NOT resemble. */
  anti_celeb_news_examples: string[];
  /** 4-6 political figures / spouses the face MUST NOT resemble. */
  anti_celeb_politician_examples: string[];
  /**
   * Polish-23 Commit 3.0.17: BODY INVARIANT.
   * First real end-to-end run rendered a full 60s composite but
   * showed body-shape drift across clips (same face, different
   * build / weight / proportions clip-to-clip). Adding an explicit
   * body-invariant bullet threaded into every clip's CHARACTER
   * LOCK prefix + into the Higgsfield Soul reference prompt so
   * Veo has a hard anchor to reject drift on.
   *
   * Format: leads with "- " like the other bullets. Example:
   * "- Medium build, waist-up framing, same weight and body
   *   proportions across every clip"
   */
  body_invariant_bullet: string;
  /**
   * Polish-23 Commit 3.0.17: SETTING INVARIANT.
   * Same class of drift as body_invariant_bullet but for the
   * environment / seating position / background props. Naming a
   * specific position AND naming the specific props visible in
   * the background gives Veo hard anchors on both.
   *
   * Example: "- Seated at her kitchen table with a ceramic
   *   coffee mug in front of her, morning window light from
   *   off-camera right, same position and background across
   *   every clip"
   */
  setting_invariant_bullet: string;
}

/**
 * Zod validator for the character-lock jsonb subkey. Strict-shaped
 * so any drift from the Polish-21.0.7 field list (silent rename,
 * dropped bullet, wrong casing on `gender`) surfaces at parse time
 * rather than mid-run when a per-clip Veo prompt tries to interpolate
 * an undefined field. Used both by the Claude ad-spec parser and by
 * the (defensive) reader in the Polish-23 Commit-3 worker.
 */
export const CharacterLockSchema: z.ZodType<CharacterLock> = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
  nationality: z.string().min(1),
  gender: z.enum(CHARACTER_GENDER_VALUES),
  demographic_role: z.string().min(1),
  hair_bullet: z.string().min(1),
  eye_asymmetry_bullet: z.string().min(1),
  nose_bullet: z.string().min(1),
  mouth_bullet: z.string().min(1),
  eye_color_and_age_detail: z.string().min(1),
  jaw_bullet: z.string().min(1),
  face_shape_bullet: z.string().min(1),
  clothing_bullet: z.string().min(1),
  setting_paragraph: z.string().min(1),
  skin_age_appropriate_detail: z.string().min(1),
  skin_color_for_stubble: z.enum(SKIN_COLOR_FOR_STUBBLE_VALUES),
  // Anti-celebrity arrays: enforce a minimum so the CRITICAL
  // ANTI-CELEBRITY DIRECTIVE block downstream has real content.
  // 4 / 2 / 2 matches Polish-21.0.7's parser thresholds so the
  // fallback / accept decision is identical across pipelines.
  anti_celeb_actress_examples: z.array(z.string().min(1)).min(4),
  anti_celeb_news_examples: z.array(z.string().min(1)).min(2),
  anti_celeb_politician_examples: z.array(z.string().min(1)).min(2),
  // Polish-23 Commit 3.0.17: body + setting invariants for
  // cross-clip drift lock.
  body_invariant_bullet: z.string().min(1),
  setting_invariant_bullet: z.string().min(1),
});

/**
 * Polish-23 Commit 1: safe-fallback everyperson used when the Claude
 * ad-spec output omits a character-lock block, malforms it, or fails
 * validation. Concrete values match Polish-21.0.7's manually-verified
 * production Linda anchor so the Polish-21 and Polish-23 pipelines
 * share the same visual reference when they fall back to the safe
 * shape.
 */
export const FALLBACK_CHARACTER_LOCK: CharacterLock = {
  name: 'Linda',
  age: 68,
  nationality: 'American',
  gender: 'female',
  demographic_role: 'suburban grandmother',
  hair_bullet:
    'Shoulder-length salt-and-pepper hair, slightly messy, NOT styled, NOT symmetrical — a couple of loose strands framing the face',
  eye_asymmetry_bullet:
    'Slightly uneven eye line — one eyelid drooping slightly more than the other (natural aging)',
  nose_bullet: 'Ordinary nose — slightly wider than average, with a small bump on the bridge',
  mouth_bullet: 'Thin lips, slightly asymmetric mouth, natural slight downturn on the left side',
  eye_color_and_age_detail: "Warm hazel eyes with visible crow's feet and slight bags underneath",
  jaw_bullet: 'Soft jawline with mild jowls (age-appropriate) — no sharp definition',
  face_shape_bullet:
    'Oval face with natural fullness at the cheeks, NOT chiseled, NOT model-shaped',
  clothing_bullet:
    'Faded navy cotton crewneck with honest wear at the neckline — not new, not designer',
  setting_paragraph:
    'Sitting at a slightly cluttered morning kitchen table — a coffee mug and unopened mail visible behind her, warm natural window light from off-camera. Cozy lived-in feel.',
  skin_age_appropriate_detail:
    "faint age spots on the cheekbones, small broken capillaries near the nose, natural crow's feet at the outer eye corners",
  skin_color_for_stubble: 'none',
  anti_celeb_actress_examples: [
    'Meryl Streep',
    'Helen Mirren',
    'Jane Fonda',
    'Diane Keaton',
    'Sally Field',
    'Goldie Hawn',
    'Susan Sarandon',
    'Glenn Close',
    'Judi Dench',
    'Maggie Smith',
  ],
  anti_celeb_news_examples: [
    'Barbara Walters',
    'Diane Sawyer',
    'Katie Couric',
    'Oprah',
    'Ellen DeGeneres',
  ],
  anti_celeb_politician_examples: [
    'Hillary Clinton',
    'Nancy Pelosi',
    'Barbara Bush',
    'Michelle Obama',
  ],
  body_invariant_bullet:
    'Medium build, average weight for a 68-year-old woman, soft midsection and shoulders — SAME weight, SAME body proportions, SAME shoulder width across every clip. NO changes in build clip-to-clip.',
  setting_invariant_bullet:
    'Seated upright at her suburban kitchen table with a white ceramic coffee mug placed in front of her, morning window light from off-camera right — SAME chair, SAME table position, SAME mug placement, SAME window-light direction across every clip. NO shift in setting or furniture.',
};

/**
 * Parse an unknown value into a CharacterLock. Falls back to
 * FALLBACK_CHARACTER_LOCK when validation fails so the pipeline
 * keeps shipping even on a malformed Claude output (this mirrors
 * the Polish-21.0.7 parseStructuredCharacter contract — partial
 * hydration produces half-Claude/half-fallback records that read
 * worse than either shape alone, so we fall back wholesale).
 */
export function parseCharacterLock(raw: unknown): CharacterLock {
  const result = CharacterLockSchema.safeParse(raw);
  return result.success ? result.data : FALLBACK_CHARACTER_LOCK;
}
