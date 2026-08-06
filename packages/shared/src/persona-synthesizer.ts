/**
 * Polish-26.0.6 Commit 61.6: heuristic persona synthesizer.
 *
 * Fallback for the polish26_heygen worker when a concept was
 * analyzed with UGC_DECONSTRUCTOR (subject-only output) rather
 * than POLISH23_VISION_SYSTEM_PROMPT (structured persona output).
 * Happens for anything analyzed BEFORE Commit 61.6 added
 * polish26_heygen to analyze-concept's usesPolish23Vision gate,
 * plus for concepts first analyzed under a non-polish25/26 job.
 *
 * Parses freeform strings — subject.appearance ("32-year-old
 * white woman with short brown hair, standing in kitchen") +
 * subject.performance + audio_cues.dialogue_quality ("energetic,
 * high-pitched female voice with slight accent") — into a
 * Polish23Persona-shaped record.
 *
 * The HeyGen matcher's HARD filters are gender + age_range (via
 * age_bucket ±2) — both of those need to come out of the
 * synthesizer correct. Ethnicity + look are SOFT scores — even
 * fuzzy/partial values still help the scorer without breaking
 * the filter.
 *
 * Returns null when we can't even derive a gender (worker fails
 * with an actionable "run analyze-concept" message rather than
 * routing to a random avatar).
 */
import type { Polish23Persona, Polish23PersonaEthnicity } from './polish23-vision-analysis';

export interface SynthesizedPersonaResult {
  persona: Polish23Persona;
  /** Which analysis fields the synthesizer read. */
  sources: string[];
}

export function synthesizePersonaFromSubject(
  analysisObj: unknown,
): SynthesizedPersonaResult | null {
  if (!analysisObj || typeof analysisObj !== 'object') return null;
  const a = analysisObj as Record<string, unknown>;

  // Pull the freeform strings that carry demographic signal.
  const subject = a['subject'];
  const subjectAppearance =
    subject && typeof subject === 'object'
      ? String((subject as Record<string, unknown>)['appearance'] ?? '')
      : '';
  const subjectPerformance =
    subject && typeof subject === 'object'
      ? String((subject as Record<string, unknown>)['performance'] ?? '')
      : '';

  const audioCues = a['audio_cues'];
  const dialogueQuality =
    audioCues && typeof audioCues === 'object'
      ? String((audioCues as Record<string, unknown>)['dialogue_quality'] ?? '')
      : '';

  const socialContext = String(a['social_context'] ?? '');

  const sources: string[] = [];
  if (subjectAppearance) sources.push('subject.appearance');
  if (subjectPerformance) sources.push('subject.performance');
  if (dialogueQuality) sources.push('audio_cues.dialogue_quality');
  if (socialContext) sources.push('social_context');

  // Combined haystack for keyword matching. Perf field gets
  // included because "she says" / "he says" narrator hints often
  // land there.
  const haystack = [subjectAppearance, subjectPerformance, dialogueQuality, socialContext]
    .join(' ')
    .toLowerCase();
  if (!haystack.trim()) return null;

  const gender = extractGender(haystack);
  if (!gender) {
    // Refuse to guess when there's no signal. Worker fails loud
    // rather than routing to an arbitrary avatar.
    return null;
  }

  const persona: Polish23Persona = {
    gender,
    age_range: extractAgeRange(haystack) ?? '30s',
    ethnicity: extractEthnicity(haystack) ?? 'other',
    // look = raw subject.appearance is the best we can do — the
    // matcher scores it as a soft signal via fuzzy substring match
    // against enriched avatars' hair_style / hair_color / wardrobe.
    look: subjectAppearance || subjectPerformance || 'unspecified',
    voice_tone: extractVoiceTone(dialogueQuality) ?? 'neutral',
  };

  return { persona, sources };
}

const MALE_KEYWORDS = [
  ' man ',
  ' man,',
  ' man.',
  ' male ',
  ' male,',
  ' male.',
  ' guy ',
  ' guys ',
  ' male-',
  ' gentleman ',
  ' gentleman,',
  ' gentleman.',
  'young man',
  'older man',
  'middle-aged man',
  ' he ',
  ' his ',
  ' him ',
  ' dude ',
  ' boy ',
  ' bro ',
];
const FEMALE_KEYWORDS = [
  ' woman ',
  ' woman,',
  ' woman.',
  ' female ',
  ' female,',
  ' female.',
  ' girl ',
  ' girls ',
  ' female-',
  ' lady ',
  ' lady,',
  ' lady.',
  'young woman',
  'older woman',
  'middle-aged woman',
  ' she ',
  ' her ',
  ' hers ',
  ' gal ',
  ' mom ',
];

function extractGender(haystack: string): 'male' | 'female' | null {
  // Pad so word-boundary lookups work at string edges.
  const padded = ` ${haystack} `;
  const maleHits = MALE_KEYWORDS.filter((k) => padded.includes(k)).length;
  const femaleHits = FEMALE_KEYWORDS.filter((k) => padded.includes(k)).length;
  if (maleHits === 0 && femaleHits === 0) return null;
  // Tie goes to female (empirically the more common UGC ad demographic).
  return maleHits > femaleHits ? 'male' : 'female';
}

const AGE_BUCKET_MATCHERS: Array<{ bucket: string; keywords: string[] }> = [
  { bucket: '20s', keywords: ['20s', '20-year', 'twenties', 'young adult', 'college-age'] },
  { bucket: '30s', keywords: ['30s', '30-year', 'thirties', 'early 30', 'late 20'] },
  { bucket: '40s', keywords: ['40s', '40-year', 'forties', 'middle-aged', 'middle aged'] },
  { bucket: '50s', keywords: ['50s', '50-year', 'fifties'] },
  { bucket: '60s', keywords: ['60s', '60-year', 'sixties', 'senior'] },
  { bucket: '70s', keywords: ['70s', '70-year', 'seventies', 'elderly'] },
];

function extractAgeRange(haystack: string): string | null {
  // Numeric-first: "32-year-old" → 30s.
  const numMatch = haystack.match(/(\d{2})[- ]year[- ]old|(\d{2})\s*(?:yo|y\/o|yr)/i);
  if (numMatch) {
    const digits = numMatch[1] ?? numMatch[2];
    const n = digits ? parseInt(digits, 10) : NaN;
    if (Number.isFinite(n) && n >= 15 && n <= 100) {
      if (n < 20) return '20s';
      if (n < 30) return '20s';
      if (n < 40) return '30s';
      if (n < 50) return '40s';
      if (n < 60) return '50s';
      if (n < 70) return '60s';
      if (n < 80) return '70s';
      return '80s+';
    }
  }
  // Keyword fallback.
  for (const m of AGE_BUCKET_MATCHERS) {
    if (m.keywords.some((k) => haystack.includes(k))) return m.bucket;
  }
  if (haystack.includes('young') || haystack.includes('teen')) return '20s';
  if (haystack.includes('older') || haystack.includes('old ')) return '60s';
  return null;
}

// Polish23PersonaEthnicity enum only has `hispanic` (no `latino`),
// so Latin-American keyword hits map to `hispanic` here. The
// downstream matcher's fuzzy scoring against the enriched
// makeugc_avatar_index (which DOES split hispanic/latino) is soft,
// so slightly-broad hispanic still matches latino-looking avatars.
const ETHNICITY_KEYWORDS: Array<{ eth: Polish23PersonaEthnicity; keywords: string[] }> = [
  { eth: 'white', keywords: ['white', 'caucasian', 'european'] },
  { eth: 'black', keywords: ['black ', 'african', 'african-american', 'african american'] },
  {
    eth: 'asian',
    keywords: ['asian', 'east asian', 'south asian', 'chinese', 'japanese', 'korean'],
  },
  {
    eth: 'hispanic',
    keywords: ['hispanic', 'spanish', 'iberian', 'latino', 'latina', 'latin american', 'mexican'],
  },
  {
    eth: 'middle_eastern',
    keywords: ['middle eastern', 'middle-eastern', 'arab', 'persian', 'iranian'],
  },
  { eth: 'mixed', keywords: ['mixed', 'biracial', 'multiracial'] },
];

function extractEthnicity(haystack: string): Polish23PersonaEthnicity | null {
  for (const m of ETHNICITY_KEYWORDS) {
    if (m.keywords.some((k) => haystack.includes(k))) return m.eth;
  }
  return null;
}

function extractVoiceTone(dialogueQuality: string): string | null {
  const s = dialogueQuality.toLowerCase();
  if (!s) return null;
  // Return the first descriptive word we recognize; else the raw
  // string (matcher's fuzzy compare handles the rest).
  const tones = [
    'energetic',
    'calm',
    'excited',
    'monotone',
    'conversational',
    'authoritative',
    'friendly',
    'urgent',
    'warm',
    'raspy',
    'smooth',
    'high-pitched',
    'deep',
  ];
  for (const t of tones) {
    if (s.includes(t)) return t;
  }
  return dialogueQuality.slice(0, 80);
}
