/**
 * Polish-25 Commit 7 regression pins — matcher side.
 *
 * Covers:
 *   - personaAgeRangeToBucket parser (free-form persona.age_range
 *     → closed MakeUGC bucket)
 *   - ageBucketNeighbors ±1 window
 *   - selectMakeugcAvatarForPersonaFromIndex
 *       * age hard-filter with ±1 tolerance
 *       * ethnicity exact-match (+10)
 *       * hair fuzzy (+5)
 *       * facial-hair fuzzy (+3)
 *       * wardrobe fuzzy (+2)
 *       * NO silent random fallback (throws)
 *
 * Vision-schema Zod round-trip tests live next to the prompt at
 * packages/jobs/tests/makeugc-avatar-vision-prompt.test.ts —
 * co-located with the operator-tuned system prompt they pin.
 *
 * Core operator-reported regression: source persona "male 60s
 * white gray hair" must NOT bind to a 30s avatar. The suite pins
 * the exact scenario as the FIRST regression test.
 */
import { describe, expect, it } from 'vitest';
import {
  ageBucketNeighbors,
  MakeugcNoMatchingAvatarError,
  personaAgeRangeToBucket,
  selectMakeugcAvatarForPersonaFromIndex,
  type MakeugcEnrichedAvatar,
  type MakeugcPersona,
  type MakeugcVoice,
} from '../src/makeugc-client';

// ---------------- Age bucket parser + neighbors ----------------

describe('Polish-25 Commit 7: personaAgeRangeToBucket', () => {
  it('parses "60s", "in my 60s", "60-year-old", "aged 62" → "60s"', () => {
    expect(personaAgeRangeToBucket('60s')).toBe('60s');
    expect(personaAgeRangeToBucket('in my 60s')).toBe('60s');
    expect(personaAgeRangeToBucket('60-year-old')).toBe('60s');
    expect(personaAgeRangeToBucket('aged 62')).toBe('60s');
    expect(personaAgeRangeToBucket('sixties')).toBe('60s');
    expect(personaAgeRangeToBucket('sixty something')).toBe('60s');
  });

  it('parses 20s-70s in numeric + word form', () => {
    expect(personaAgeRangeToBucket('20s')).toBe('20s');
    expect(personaAgeRangeToBucket('mid-30s')).toBe('30s');
    expect(personaAgeRangeToBucket('40s')).toBe('40s');
    expect(personaAgeRangeToBucket('fifty')).toBe('50s');
    expect(personaAgeRangeToBucket('seventies')).toBe('70s');
  });

  it('collapses 80s+ inputs to "80s+"', () => {
    expect(personaAgeRangeToBucket('80s')).toBe('80s+');
    expect(personaAgeRangeToBucket('82')).toBe('80s+');
    expect(personaAgeRangeToBucket('nineties')).toBe('80s+');
    expect(personaAgeRangeToBucket('elderly')).toBe('80s+');
    expect(personaAgeRangeToBucket('senior')).toBe('80s+');
  });

  it('returns null for unparseable input', () => {
    expect(personaAgeRangeToBucket('')).toBeNull();
    expect(personaAgeRangeToBucket('adult')).toBeNull();
    expect(personaAgeRangeToBucket('unknown')).toBeNull();
  });
});

describe('Polish-25 Commit 7: ageBucketNeighbors ±1 window', () => {
  it('60s → 50s/60s/70s', () => {
    expect(ageBucketNeighbors('60s')).toEqual(['50s', '60s', '70s']);
  });

  it('20s → 20s/30s (no bucket below)', () => {
    expect(ageBucketNeighbors('20s')).toEqual(['20s', '30s']);
  });

  it('80s+ → 70s/80s+ (no bucket above)', () => {
    expect(ageBucketNeighbors('80s+')).toEqual(['70s', '80s+']);
  });

  it('unknown bucket → empty', () => {
    expect(ageBucketNeighbors('55s')).toEqual([]);
  });
});

// ---------------- Enriched matcher ----------------

describe('Polish-25 Commit 7: selectMakeugcAvatarForPersonaFromIndex', () => {
  const mkAvatar = (
    overrides: Partial<MakeugcEnrichedAvatar> & {
      avatarId: string;
      makeugcGender: string;
      ageBucket: string;
      ethnicity: string;
      hairColor: string;
    },
  ): MakeugcEnrichedAvatar => ({
    avatarName: overrides.avatarId,
    hairStyle: null,
    facialHair: null,
    wardrobeStyle: null,
    wardrobeSummary: null,
    backgroundSetting: null,
    ...overrides,
  });
  const mkVoice = (id: string, gender: string): MakeugcVoice => ({
    id,
    name: id,
    gender,
    language: 'English',
    voiceId: `tts_${id}`,
  });

  it('THE regression pin: male 60s white gray-hair persona picks 60s (not 30s)', () => {
    // Real evidence: pre-Commit-7, matcher picked 30s male because the
    // API only exposed { id, name, thumbnail, gender } — no age
    // metadata. With enriched index + age±1 hard filter, 30s falls out
    // of the pool entirely.
    const persona: MakeugcPersona = {
      gender: 'male',
      age_range: '60s',
      ethnicity: 'white',
      look: 'gray hair, clean-shaven',
    };
    const avatars = [
      mkAvatar({
        avatarId: 'a_young',
        makeugcGender: 'Male',
        ageBucket: '30s',
        ethnicity: 'white',
        hairColor: 'brown',
      }),
      mkAvatar({
        avatarId: 'a_old_match',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
        facialHair: 'clean_shaven',
      }),
      mkAvatar({
        avatarId: 'a_middle',
        makeugcGender: 'Male',
        ageBucket: '50s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
    ];
    const voices = [mkVoice('v_male', 'Male')];
    const match = selectMakeugcAvatarForPersonaFromIndex(persona, avatars, voices);
    expect(match.avatar.avatarId).toBe('a_old_match');
    // ±1 tolerance: 50s IS in the pool but scores lower than 60s.
    expect(match.matchLog.hardFilters.join(',')).toContain('50s');
    expect(match.matchLog.hardFilters.join(',')).toContain('60s');
    expect(match.matchLog.hardFilters.join(',')).toContain('70s');
    // 30s is EXCLUDED — hard filter rejected it before scoring.
    expect(match.matchLog.scoredCandidates.every((c) => c.avatarId !== 'a_young')).toBe(true);
    expect(match.matchLog.matchStrategy).toBe('enriched-index');
  });

  it('ethnicity exact match adds +10 to the score', () => {
    const persona: MakeugcPersona = {
      gender: 'male',
      age_range: '60s',
      ethnicity: 'white',
    };
    const avatars = [
      mkAvatar({
        avatarId: 'a_black',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'black',
        hairColor: 'black',
      }),
      mkAvatar({
        avatarId: 'a_white',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
    ];
    const match = selectMakeugcAvatarForPersonaFromIndex(persona, avatars, [
      mkVoice('v_male', 'Male'),
    ]);
    expect(match.avatar.avatarId).toBe('a_white');
    const winnerBreakdown = match.matchLog.scoredCandidates[0]!.breakdown;
    expect(winnerBreakdown.ethnicity).toBe(10);
  });

  it('hair fuzzy adds +5 (persona.look substring on avatar.hairColor)', () => {
    const persona: MakeugcPersona = {
      gender: 'male',
      age_range: '60s',
      ethnicity: 'white',
      look: 'gray hair',
    };
    const avatars = [
      mkAvatar({
        avatarId: 'a_brown',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'brown',
      }),
      mkAvatar({
        avatarId: 'a_gray',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
    ];
    const match = selectMakeugcAvatarForPersonaFromIndex(persona, avatars, [
      mkVoice('v_male', 'Male'),
    ]);
    expect(match.avatar.avatarId).toBe('a_gray');
    const winnerBreakdown = match.matchLog.scoredCandidates[0]!.breakdown;
    expect(winnerBreakdown.hair).toBe(5);
  });

  it('facial-hair fuzzy adds +3 (persona.look "clean-shaven" hits facial_hair="clean_shaven")', () => {
    const persona: MakeugcPersona = {
      gender: 'male',
      age_range: '60s',
      ethnicity: 'white',
      look: 'clean-shaven',
    };
    const avatars = [
      mkAvatar({
        avatarId: 'a_beard',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
        facialHair: 'beard',
      }),
      mkAvatar({
        avatarId: 'a_smooth',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
        facialHair: 'clean_shaven',
      }),
    ];
    const match = selectMakeugcAvatarForPersonaFromIndex(persona, avatars, [
      mkVoice('v_male', 'Male'),
    ]);
    expect(match.avatar.avatarId).toBe('a_smooth');
    const winnerBreakdown = match.matchLog.scoredCandidates[0]!.breakdown;
    expect(winnerBreakdown.facialHair).toBe(3);
  });

  it('wardrobe fuzzy adds +2 (persona.look substring on wardrobeSummary)', () => {
    const persona: MakeugcPersona = {
      gender: 'male',
      age_range: '60s',
      ethnicity: 'white',
      look: 'blue polo shirt',
    };
    const avatars = [
      mkAvatar({
        avatarId: 'a_suit',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
        wardrobeStyle: 'formal',
        wardrobeSummary: 'black three-piece suit with tie',
      }),
      mkAvatar({
        avatarId: 'a_polo',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
        wardrobeStyle: 'business_casual',
        wardrobeSummary: 'navy blue polo shirt',
      }),
    ];
    const match = selectMakeugcAvatarForPersonaFromIndex(persona, avatars, [
      mkVoice('v_male', 'Male'),
    ]);
    expect(match.avatar.avatarId).toBe('a_polo');
    const winnerBreakdown = match.matchLog.scoredCandidates[0]!.breakdown;
    expect(winnerBreakdown.wardrobe).toBe(2);
  });

  it('THROWS MakeugcNoMatchingAvatarError when gender pool is empty (NO silent random fallback)', () => {
    const persona: MakeugcPersona = { gender: 'male', age_range: '60s' };
    const avatars = [
      mkAvatar({
        avatarId: 'a',
        makeugcGender: 'Female',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
    ];
    expect(() =>
      selectMakeugcAvatarForPersonaFromIndex(persona, avatars, [mkVoice('v_male', 'Male')]),
    ).toThrow(MakeugcNoMatchingAvatarError);
  });

  it('THROWS when age filter excludes every survivor (persona 20s, only 70s avatars)', () => {
    const persona: MakeugcPersona = { gender: 'male', age_range: '20s' };
    const avatars = [
      mkAvatar({
        avatarId: 'a',
        makeugcGender: 'Male',
        ageBucket: '70s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
    ];
    expect(() =>
      selectMakeugcAvatarForPersonaFromIndex(persona, avatars, [mkVoice('v_male', 'Male')]),
    ).toThrow(MakeugcNoMatchingAvatarError);
  });

  it('skips age hard filter when persona.age_range is unparseable + records the skip in hardFilters', () => {
    const persona: MakeugcPersona = {
      gender: 'male',
      age_range: 'adult',
      ethnicity: 'white',
    };
    const avatars = [
      mkAvatar({
        avatarId: 'a_30',
        makeugcGender: 'Male',
        ageBucket: '30s',
        ethnicity: 'white',
        hairColor: 'brown',
      }),
      mkAvatar({
        avatarId: 'a_60',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
    ];
    const match = selectMakeugcAvatarForPersonaFromIndex(persona, avatars, [
      mkVoice('v_male', 'Male'),
    ]);
    // Both survive — pick whichever scores highest (both score +10
    // on ethnicity; tiebreak on ordering — first in list).
    expect(['a_30', 'a_60']).toContain(match.avatar.avatarId);
    expect(match.matchLog.hardFilters.some((f) => f.includes('unparseable'))).toBe(true);
  });

  it('excludes churned avatarId from second-best selection', () => {
    const persona: MakeugcPersona = {
      gender: 'male',
      age_range: '60s',
      ethnicity: 'white',
    };
    const avatars = [
      mkAvatar({
        avatarId: 'a_first',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
      mkAvatar({
        avatarId: 'a_second',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
    ];
    const match = selectMakeugcAvatarForPersonaFromIndex(
      persona,
      avatars,
      [mkVoice('v_male', 'Male')],
      { exclude: ['a_first'] },
    );
    expect(match.avatar.avatarId).toBe('a_second');
  });

  it('winnerVoiceId is the MakeUGC UUID (voice.id) — Commit 5 discipline preserved', () => {
    const persona: MakeugcPersona = {
      gender: 'male',
      age_range: '60s',
      ethnicity: 'white',
    };
    const avatars = [
      mkAvatar({
        avatarId: 'a',
        makeugcGender: 'Male',
        ageBucket: '60s',
        ethnicity: 'white',
        hairColor: 'gray',
      }),
    ];
    const voice: MakeugcVoice = {
      id: 'makeugc_uuid_here',
      name: 'v',
      gender: 'Male',
      language: 'English',
      voiceId: 'elevenlabs_opaque_string',
    };
    const match = selectMakeugcAvatarForPersonaFromIndex(persona, avatars, [voice]);
    expect(match.matchLog.winnerVoiceId).toBe('makeugc_uuid_here');
    expect(match.matchLog.winnerVoiceId).not.toBe('elevenlabs_opaque_string');
  });
});
