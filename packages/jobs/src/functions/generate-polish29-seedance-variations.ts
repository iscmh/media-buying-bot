/**
 * Polish-29.0.10 Commit 119: credit-backed multi-clip Seedance
 * VARIATIONS worker — the "feed winning creative, get N cloned-
 * character variations" flow.
 *
 * Value prop:
 *   1. User uploaded a winning ad (any length; typical 30-60s).
 *   2. Vision analysis extracted persona + script structure.
 *   3. Claude generates N distinct persona+script pairs.
 *   4. For each variation:
 *        - Nano Banana Pro renders ONE character-reference PNG from
 *          persona.look — visual anchor threaded through every clip.
 *        - The script splits into M ~8-second clip-length chunks
 *          matching the source ad's duration (~22 words per clip
 *          at 170 wpm).
 *        - For each of the M clips: Seedance i2v with:
 *            image ref  = the Nano Banana PNG
 *            prompt     = persona-lock prefix + segment dialogue
 *          Each clip is one credit-reserved call at the chosen tier
 *          (2.0 Fast / 2.0 / 2.5). Character consistency = image
 *          reference; script continuity = same persona prefix.
 *        - Replicate ffmpeg-concat stitches the M clips into one
 *          composite matching source ad length.
 *        - Store composite → persist creative row.
 *   5. Output: N full-length composite ads, each a different
 *      persona pitching the same offer.
 *
 * BYOK requirement: Claude (batch persona+script), Gemini (Nano
 * Banana Pro character reference), Replicate (ffmpeg concat).
 * The Seedance video render itself pays in CREDITS via useapi.net.
 * Zero HeyGen / ElevenLabs — Seedance's own audio generation covers
 * lip-sync + voice.
 *
 * Per-clip credit ledger (via runSeedanceCreditedJob from Commit
 * 114): reserve → submit → poll → consume on success, release on
 * failure. Partial success = user pays only for the clips that
 * rendered.
 *
 * Cost example (5 variations, source ad = 32s → 4 clips per variant):
 *   5 × 4 × 20 credits (Seedance 2.0) = 400 credits = $8.00
 *   plus Claude batch (~$0.05) + 5 × Nano Banana ($0.13 each) +
 *   5 × Replicate concat (~$0.02 each). Retail equivalent for the
 *   video generation alone: 5 × 4 × $2.25 = $45.
 */
import { Buffer } from 'node:buffer';
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  checkReplicateConcat,
  cloneCharacterReferenceImage,
  composeNanoBananaCharacterClonePrompt,
  getDreaminaAccountBalance,
  submitReplicateConcat,
  uploadUseapiAsset,
} from '@mbb/ai-providers';
import { getDb, InsufficientCreditsError, schema } from '@mbb/db';
import { getCreditModel, POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { loadDecryptedKeys, MissingProviderKeyError } from '../lib/load-keys';
import { markJobFailed } from '../lib/job-markers';
import {
  assertNoUndefinedForPostgres,
  assertScalarDefinedForPostgres,
  guardedStepRun,
} from '../lib/assert-no-undefined-for-postgres';
import { safeInngestStepReturn } from '../lib/strip-undefined';
import {
  POLISH28_VARIATIONS_SYSTEM_PROMPT,
  composePolish28VariationsUserPrompt,
  parsePolish28VariationsResponse,
  type Polish28VariationEntry,
} from '../lib/polish28-variations-prompt';
// Polish-29.0.15 Commit 124: intentionally NOT importing
// wrapWithPsywarCorpus. Its "psychological manipulation techniques"
// framing triggers Claude Sonnet 4.5+ refusals (observed on 29.0.14 —
// Claude returned a prose safety flag instead of JSON, which broke the
// parser). The Polish-28 variations prompt on its own reads as normal
// ad-copy work and produces the persona+script JSON cleanly.
import { runSeedanceCreditedJob } from '../lib/seedance-credit-flow';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';

console.log(
  `[jobs.generate-polish29-seedance-variations] cold start — POLISH_VERSION=${POLISH_VERSION}`,
);

// -----------------------------------------------------------------
// Constants
// -----------------------------------------------------------------

const MAX_VARIANTS_PER_JOB = 10;
/**
 * Max clips per variation. Polish-29.0.30 Commit 139: 10 → 5.
 * A 10-clip variation burns 10 × 35 Dreamina credits = 350 credits per
 * test run. At $10/1000 credits that's $3.50 of Dreamina spend per
 * test — brutal for iteration. Capping at 5 clips = 175 credits per
 * test (~5-6 tests per $10 Dreamina pack). Real UGC ads are 30-40s
 * anyway, so 5 × 8s = 40s composite is on-target for a typical
 * Meta Reels/TikTok spec.
 */
const MAX_CLIPS_PER_VARIANT = 5;
/** Min clips per variation. */
const MIN_CLIPS_PER_VARIANT = 2;
/** Default clips when source ad duration is unknown. */
const DEFAULT_CLIPS_PER_VARIANT = 4;
/** Seedance clip length in seconds. 8s = Seedance's per-call max. */
const SEEDANCE_CLIP_SECONDS = 8;
/**
 * Words per clip. Polish-29.0.29 Commit 138: 10 → 14.
 * 29.0.28 (10 words / 8s ≈ 75 wpm) was TOO SLOW — user feedback "its
 * non human". The rate ping-pong: 22 was machine-gun robotic, 15 was
 * still fast, 10 was too slow. 14 words / 8s ≈ 105 wpm — the
 * conversational natural-UGC talking rate. Real people on TikTok
 * average 110-140 wpm.
 */
const WORDS_PER_CLIP = 14;
/**
 * Polish-29.0.30 Commit 139: 80 → 55 words. 80 was pushing Claude
 * to write ~140 word scripts which produced 10-clip variations
 * (MAX-capped) → 350 Dreamina credits per test = $3.50/test. 55 words
 * gives ~4-5 clips at 14 words each = 32-40s composite, 140-175
 * Dreamina credits per test, ~$1.75/test. Better cost per iteration
 * while staying above the "just enough to be a real ad" threshold.
 */
const MIN_SCRIPT_WORDS = 55;
const DEFAULT_MODEL_ID = 'seedance-2-0-ugc';
const ALLOWED_MODEL_IDS = new Set([
  'seedance-2-5-ugc',
  'seedance-2-0-ugc',
  'seedance-2-0-fast-ugc',
]);

const CONCAT_POLL_INTERVAL_SECONDS = 5;
const CONCAT_POLL_MAX_ATTEMPTS = 36; // ~3 min

/**
 * Event payload shape.
 *
 * The concept-generate form dispatches through analyze-concept, which
 * only forwards {jobId, userId, mode}. So pipeline-specific config
 * (modelId / aspectRatio / dreaminaAccount) is read from:
 *   - job.metadata.model_id (set by the form's actions.ts when the
 *     Polish-29 variations card is picked)
 *   - job.metadata.aspect_ratio (form-controlled; defaults to 9:16)
 *   - USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT env var (platform-side
 *     Dreamina account registered on useapi.net; same source the
 *     Quick Seedance form uses)
 *
 * Direct-dispatch API callers (integration tests, Inngest replay from
 * the dashboard) can override any of these via event.data.
 */
export interface Polish29SeedanceVariationsEventPayload {
  jobId: string;
  userId: string;
  dreaminaAccount?: string;
  modelId?: string;
  aspectRatio?: '9:16' | '1:1';
}

// -----------------------------------------------------------------
// Helpers (pure — trivial to test in isolation later)
// -----------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Polish-29.0.26 Commit 135: inject ellipses at natural pause points
 * to slow Seedance TTS delivery.
 *
 * Seedance reads punctuation as timing hints. A bare 10-word sentence
 * with no punctuation gets rushed through in 3s; the same words with
 * pauses take the full 8s. Rules:
 *   - Every 4th word gets a trailing comma if it doesn't already have
 *     terminal punctuation nearby.
 *   - Any word followed by a period gets an ellipsis instead (bigger
 *     pause than a period on its own).
 *   - Existing commas / ellipses preserved.
 */
export function insertNaturalPauses(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return text; // too short to need pause insertion
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    // Terminal '.' → '...' for a bigger pause
    if (w.endsWith('.') && !w.endsWith('...')) {
      out.push(w.slice(0, -1) + '...');
      continue;
    }
    // Every 4th word: add trailing comma if the word has no punctuation yet
    if (i > 0 && (i + 1) % 4 === 0 && /[a-z0-9]$/i.test(w)) {
      out.push(w + ',');
      continue;
    }
    out.push(w);
  }
  return out.join(' ');
}

/**
 * Split a full script into per-clip dialogue chunks. Polish-29.0.27
 * Commit 136: split at SENTENCE BOUNDARIES, not word boundaries.
 *
 * User feedback on 29.0.26: clip 1 sounded natural, clips 2-4 sped up.
 * Root cause: the old word-chunking algorithm cut the script mid-
 * sentence, so clip 1 opened with a complete sentence ("Hey guys, so I
 * tried this…") but clips 2+ opened with a fragment ("worked in three
 * days plus my skin…"). Seedance's TTS models each clip as a fresh
 * utterance — full-sentence chunks pace naturally, mid-sentence
 * fragments get rushed to "catch up".
 *
 * Algorithm:
 *   1. Split the script into sentences on `.`, `!`, `?`.
 *   2. Greedily group sentences into chunks: keep adding sentences to
 *      the current chunk until adding another would push it past
 *      WORDS_PER_CLIP.
 *   3. If a single sentence is longer than 1.5 × WORDS_PER_CLIP, split
 *      that one sentence at word boundaries as a fallback (rare —
 *      most ad-copy sentences are 5-15 words).
 *
 * Guarantees each returned chunk:
 *   - Starts on a sentence boundary
 *   - Ends on a sentence boundary (has terminal punctuation)
 *   - Contains 1+ complete sentences (Seedance TTS will pace naturally)
 */
export function splitScriptIntoClips(script: string, targetClipCount: number): string[] {
  const trimmed = script.trim();
  if (!trimmed) return [];

  // Split into sentences. The regex captures each sentence including
  // its trailing punctuation. Falls back to the whole script if no
  // terminal punctuation exists (Claude sometimes omits).
  const sentenceMatches = trimmed.match(/[^.!?]+[.!?]+/g);
  const sentences =
    sentenceMatches && sentenceMatches.length > 0
      ? sentenceMatches.map((s) => s.trim()).filter(Boolean)
      : [trimmed];

  // Greedily group sentences into ~WORDS_PER_CLIP-sized chunks.
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;
  const wordCountOf = (s: string) => s.split(/\s+/).filter(Boolean).length;

  for (const sentence of sentences) {
    const sw = wordCountOf(sentence);
    // If this single sentence alone exceeds the soft cap, flush what
    // we have and split the giant sentence at word boundaries.
    if (sw > Math.ceil(WORDS_PER_CLIP * 1.5)) {
      if (current.length > 0) {
        chunks.push(current.join(' '));
        current = [];
        currentWordCount = 0;
      }
      const words = sentence.split(/\s+/).filter(Boolean);
      const wordsPerSub = WORDS_PER_CLIP;
      for (let i = 0; i < words.length; i += wordsPerSub) {
        const sub = words.slice(i, i + wordsPerSub).join(' ');
        // Ensure the sub ends with terminal punctuation so Seedance
        // sees a complete-utterance signal.
        chunks.push(/[.!?]$/.test(sub) ? sub : sub + '.');
      }
      continue;
    }
    // Would appending exceed the target? Flush first.
    if (currentWordCount + sw > WORDS_PER_CLIP && current.length > 0) {
      chunks.push(current.join(' '));
      current = [];
      currentWordCount = 0;
    }
    current.push(sentence);
    currentWordCount += sw;
  }
  if (current.length > 0) chunks.push(current.join(' '));

  // Respect the caller's soft target — but only as a MINIMUM. If the
  // sentence-grouped split produced fewer chunks than targetClipCount
  // (short script), keep what we have — no point padding with silence.
  // If more (long script), let it run — better a longer composite than
  // a rushed one.
  const clamped = Math.max(MIN_CLIPS_PER_VARIANT, Math.min(MAX_CLIPS_PER_VARIANT, targetClipCount));
  // If the sentence-grouped count exceeds MAX_CLIPS_PER_VARIANT, merge
  // trailing chunks so we don't blow the concat budget.
  while (chunks.length > MAX_CLIPS_PER_VARIANT) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] = chunks[chunks.length - 1] + ' ' + last;
  }
  // Suppress unused-var lint; kept for future re-introduction of a
  // hard target-count reflow if UX evolves that way.
  void clamped;
  return chunks;
}

/**
 * Derive clip count from source ad duration. If unknown, default to
 * DEFAULT_CLIPS_PER_VARIANT (~32s composite). Clamped to
 * [MIN_CLIPS_PER_VARIANT, MAX_CLIPS_PER_VARIANT].
 */
export function pickClipCountForSourceDuration(sourceSeconds: number | null): number {
  if (!sourceSeconds || sourceSeconds <= 0 || !Number.isFinite(sourceSeconds)) {
    return DEFAULT_CLIPS_PER_VARIANT;
  }
  const raw = Math.round(sourceSeconds / SEEDANCE_CLIP_SECONDS);
  return Math.max(MIN_CLIPS_PER_VARIANT, Math.min(MAX_CLIPS_PER_VARIANT, raw));
}

/**
 * Compose the per-clip Seedance prompt. The character-lock prefix
 * repeats verbatim across every clip in a variation so Seedance sees
 * identical persona text on every call. The image reference PNG
 * (Nano Banana output) is the visual anchor; this prefix is the text
 * anchor. Together they minimize character drift between clips.
 */
export function composeClipPrompt(input: {
  personaLockPrefix: string;
  clipDialogue: string;
  clipIndex: number;
  totalClips: number;
}): string {
  // Polish-29.0.28 Commit 137: destructure without clipIndex/totalClips.
  // User feedback on 29.0.27: sentence-boundary split didn't help — clip 1
  // still natural, clips 2+ still sped up. Diagnosis: my "SHOT 2 OF 4 — one
  // continuous take" prompt was telling Seedance it was in the MIDDLE of a
  // multi-shot sequence. Middle segments get paced faster (Seedance
  // interprets them as continuation, "we've still got more to cover"). Clip
  // 1 always sounded natural because "SHOT 1 OF N" reads as an opening
  // beat that gets time to establish.
  //
  // Fix: treat every clip as a STANDALONE UGC selfie video. Zero clip-index
  // metadata, zero "part of a series" language. Each Seedance call is an
  // independent generation; each prompt should look identical structurally
  // to Seedance. If clip 1 paces naturally, all clips will.
  const { personaLockPrefix, clipDialogue } = input;
  // Polish-29.0.26 Commit 135: inject ellipses at natural pause points
  // in the dialogue.
  const dialogueRaw = clipDialogue.replace(/\s+/g, ' ').trim();
  const dialogue = insertNaturalPauses(dialogueRaw);
  // Silence unused-var lint for the interface fields we intentionally
  // ignore — kept on the type so callers don't need to change shape.
  void input.clipIndex;
  void input.totalClips;
  return [
    `${personaLockPrefix}\n\n`,
    `A single 8-second UGC selfie video of the person from the reference image, talking directly to the camera.\n\n`,
    `CAMERA — HARD RULES:\n`,
    `- Static handheld phone camera. No zoom. No pan. No dolly. No tilt. No push-in. No pull-out. No parallax. No re-framing.\n`,
    `- Slight, natural handheld micro-wobble is fine — cinematic camera moves are NOT.\n`,
    `- Fixed medium close-up on the speaker's face and upper chest, same framing as the reference image.\n\n`,
    `LOOK — HARD RULES:\n`,
    `- Amateur raw selfie video. Unedited. No color grading. No cinematic bokeh. No dramatic lighting shifts.\n`,
    `- Same person, same clothing, same background, same lighting as the reference image throughout the entire clip.\n`,
    `- Aesthetic: iPhone front-camera talking-head UGC, the kind a real customer would post to TikTok.\n\n`,
    `DELIVERY — HARD RULES:\n`,
    `- Target speech rate: approximately 105 words per minute — natural conversational pace, the way a real person talks to a friend on their phone.\n`,
    `- Real pauses between phrases (respect the commas and ellipses in the dialogue below — those are timing markers).\n`,
    `- Warm, sincere, casual tone. Direct to camera.\n`,
    `- Do NOT rush. Do NOT speed up to fit the 8-second clip length — if you finish speaking early, stay silent and hold the frame.\n`,
    `- Do NOT over-enunciate. Do NOT perform. Do NOT act.\n\n`,
    `DIALOGUE (commas and ellipses are pause markers — respect them literally, do not just glide over):\n`,
    `"${dialogue}"`,
  ].join('');
}

/**
 * Compose the persona-lock prefix from Claude's persona output. This
 * prefix is threaded verbatim into every clip's Seedance prompt for
 * the variation — the same "same person" hint Google Veo used in the
 * Polish-23 CHARACTER LOCK pattern.
 */
export function composePersonaLockPrefix(persona: Polish28VariationEntry['persona']): string {
  return [
    `SAME PERSON THROUGHOUT — do not change identity between clips:`,
    `- A ${persona.age_range} ${persona.ethnicity} ${persona.gender}.`,
    `- Look: ${persona.look}`,
  ].join('\n');
}

// -----------------------------------------------------------------
// Metadata patch helper
// -----------------------------------------------------------------

async function patchMetadata(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const row = await db.query.generationJobs.findFirst({
    where: eq(schema.generationJobs.id, jobId),
    columns: { metadata: true },
  });
  const existing = (row?.metadata ?? {}) as Record<string, unknown>;
  const cleaned = assertNoUndefinedForPostgres(
    { ...existing, ...patch },
    'polish29-seedance-variations:patchMetadata',
  );
  await db
    .update(schema.generationJobs)
    .set({ metadata: cleaned })
    .where(eq(schema.generationJobs.id, jobId));
}

// -----------------------------------------------------------------
// Inngest worker
// -----------------------------------------------------------------

export const generatePolish29SeedanceVariations = inngest.createFunction(
  {
    id: 'generate-polish29-seedance-variations',
    name: 'Polish-29: credit-backed multi-clip Seedance variations',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish29-seedance-variations.requested' },
  async ({ event, step }) => {
    const data = event.data as Polish29SeedanceVariationsEventPayload;
    const startedAt = Date.now();
    const jobUserId = assertScalarDefinedForPostgres(
      data.userId,
      'userId',
      'polish29-seedance-var:entry',
    );

    // ---------- A: load job ----------
    const job = await guardedStepRun(step, 'load-job', async () => {
      const db = getDb();
      const row = await db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, data.jobId),
        columns: { variantCount: true, metadata: true, conceptIds: true },
      });
      return safeInngestStepReturn(row ?? null);
    });
    if (!job) {
      await markJobFailed(data.jobId, jobUserId, 'Job row not found', 0);
      return { jobId: data.jobId, generated: 0 };
    }
    const conceptId = job.conceptIds?.[0];
    if (!conceptId) {
      const msg =
        'Seedance-variations requires a concept with vision-analyzed metadata. ' +
        'Upload the source ad and re-run analyze-concept first.';
      await markJobFailed(data.jobId, jobUserId, msg, 0);
      throw new NonRetriableError(msg);
    }
    const requestedVariantCount = Math.max(
      1,
      Math.min(MAX_VARIANTS_PER_JOB, job.variantCount ?? 1),
    );

    // Resolve pipeline-specific config: event.data wins (direct API /
    // Inngest replay), else read from job.metadata (concept-form path),
    // else env / defaults.
    const jobMetadata = (job.metadata ?? {}) as Record<string, unknown>;
    // Prefer the pipeline-specific slot so this worker never fights
    // analyze-concept's metadata.model_id → video-variant dispatch.
    // Fall back to model_id if present (direct-dispatch / test paths
    // sometimes set it there).
    const metaModelId =
      typeof jobMetadata['polish29_model_id'] === 'string'
        ? (jobMetadata['polish29_model_id'] as string)
        : typeof jobMetadata['model_id'] === 'string'
          ? (jobMetadata['model_id'] as string)
          : undefined;
    const metaAspectRatio =
      typeof jobMetadata['aspect_ratio'] === 'string'
        ? (jobMetadata['aspect_ratio'] as string)
        : undefined;
    const modelIdCandidate = data.modelId ?? metaModelId ?? DEFAULT_MODEL_ID;
    const modelId = ALLOWED_MODEL_IDS.has(modelIdCandidate) ? modelIdCandidate : DEFAULT_MODEL_ID;
    const model = getCreditModel(modelId);
    const aspectRatioCandidate = data.aspectRatio ?? metaAspectRatio ?? '9:16';
    const aspectRatio: '9:16' | '1:1' = aspectRatioCandidate === '1:1' ? '1:1' : '9:16';
    // Dreamina account: platform-side registered account on useapi.net,
    // NOT a per-user field. Same env var the Quick Seedance form reads.
    const dreaminaAccount =
      data.dreaminaAccount ?? process.env['USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT'];
    if (!dreaminaAccount) {
      const msg =
        'USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT env var is unset. An admin needs to register a ' +
        'Dreamina account on useapi.net and set the env var to that account email.';
      await markJobFailed(data.jobId, jobUserId, msg, 0);
      throw new NonRetriableError(msg);
    }

    // ---------- B: mark processing ----------
    await guardedStepRun(step, 'mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, data.jobId));
      await patchMetadata(data.jobId, {
        polish29_seedance_variations_start: {
          model_id: modelId,
          variant_count_requested: requestedVariantCount,
          per_clip_credits: model.credits,
          aspect_ratio: aspectRatio,
          at: nowIso(),
        },
      });
      return safeInngestStepReturn({ ok: true });
    });

    // ---------- C: preflight BYOK (Claude + Gemini + Replicate) ----------
    // NOTE: Replicate lives under the 'kling' slot on DecryptedKeys —
    // that's the legacy tag Polish-20 kept when the Replicate shared
    // helpers (concat / lipsync / audio / frame) all coalesced on one
    // Replicate token. Same pattern as generate-video-variant +
    // generate-polish23-veo-lite.
    const keys = await guardedStepRun(step, 'preflight-byok', async () => {
      try {
        const loaded = await loadDecryptedKeys(jobUserId, ['claude', 'gemini', 'kling']);
        if (!loaded.claude) throw new MissingProviderKeyError('claude');
        if (!loaded.gemini) throw new MissingProviderKeyError('gemini');
        if (!loaded.kling) throw new MissingProviderKeyError('kling');
        return safeInngestStepReturn({
          claude: loaded.claude,
          gemini: loaded.gemini,
          kling: loaded.kling,
        });
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          throw new NonRetriableError(
            `Seedance variations needs 3 BYOK keys (Claude + Gemini + Replicate). ` +
              `Missing: ${err.message}. Connect at /settings/connections. ` +
              `(Video render itself pays in credits — these keys drive persona+script batch, character reference, and clip concat.)`,
          );
        }
        throw err;
      }
    });

    // ---------- C2: pre-flight Dreamina account balance ----------
    // Polish-29.0.30 Commit 139: bail BEFORE Claude batch + Nano Banana
    // BYOK spend when the Dreamina account is out of credits. Each
    // variation needs at most MAX_CLIPS_PER_VARIANT × 35 Dreamina
    // credits (35 is the ~observed per-clip Dreamina charge for
    // Seedance 2.0 720p 8s). With N variations that's the ceiling —
    // failing fast here avoids blowing ~$0.20 of BYOK $$ on a run
    // that will only ever succeed at 0/N clips.
    const APPROX_DREAMINA_CREDITS_PER_CLIP = 35;
    await guardedStepRun(step, 'preflight-dreamina-balance', async () => {
      const balance = await getDreaminaAccountBalance({
        userId: jobUserId,
        account: dreaminaAccount,
      });
      if (!balance.ok) {
        // Log and continue — a Dreamina API blip shouldn't kill the
        // run, and the per-clip submit will surface a real error if
        // credits really are gone.
        console.warn(
          `[polish29-seedance-var] Dreamina balance check failed (${balance.errorMessage}) — continuing with generation anyway.`,
        );
        return safeInngestStepReturn({ ok: true, skipped: true });
      }
      const needed =
        requestedVariantCount * MAX_CLIPS_PER_VARIANT * APPROX_DREAMINA_CREDITS_PER_CLIP;
      if (balance.totalCredits < APPROX_DREAMINA_CREDITS_PER_CLIP) {
        // Not even 1 clip's worth. Fail hard.
        throw new NonRetriableError(
          `Dreamina account ${dreaminaAccount} is out of credits (${balance.totalCredits} remaining, need at least ${APPROX_DREAMINA_CREDITS_PER_CLIP} for 1 clip). Top up at dreamina.ai/billing (or wait for daily/monthly refill).`,
        );
      }
      if (balance.totalCredits < needed) {
        // Enough for SOME clips but not the full render. Warn and
        // proceed — the resilient per-clip loop from Commit 132 will
        // salvage what it can.
        console.warn(
          `[polish29-seedance-var] Dreamina balance (${balance.totalCredits}) is below the ceiling estimate (${needed}) for ${requestedVariantCount} variations. Some clips may fail with ret:1006. Consider topping up.`,
        );
      }
      return safeInngestStepReturn({
        ok: true,
        totalCredits: balance.totalCredits,
        region: balance.region,
      });
    });

    // ---------- D: load concept + vision-analysis JSON + source duration ----------
    const source = await guardedStepRun(step, 'load-source-context', async () => {
      const db = getDb();
      const concept = await db.query.concepts.findFirst({
        where: eq(schema.concepts.id, conceptId),
        columns: { metadata: true, ugcOriginalScript: true },
      });
      if (!concept) {
        throw new NonRetriableError(`Seedance-variations: concept ${conceptId} not found.`);
      }
      const conceptMeta = (concept.metadata ?? null) as Record<string, unknown> | null;
      const analysis = (conceptMeta?.['analysis'] ?? null) as Record<string, unknown> | null;
      const visionAnalysisJson = analysis ? JSON.stringify(analysis, null, 2) : null;
      const sourceSecondsRaw = analysis?.['duration_seconds'];
      const sourceSeconds =
        typeof sourceSecondsRaw === 'number' && Number.isFinite(sourceSecondsRaw)
          ? sourceSecondsRaw
          : null;
      return safeInngestStepReturn({
        visionAnalysisJson,
        ugcOriginalScript: concept.ugcOriginalScript ?? '',
        sourceSeconds,
      });
    });

    const clipsPerVariant = pickClipCountForSourceDuration(source.sourceSeconds);

    // ---------- E: Claude batch → N persona+script pairs ----------
    const variations = await guardedStepRun(step, 'generate-variations', async () => {
      const rawInput =
        source.visionAnalysisJson ??
        (source.ugcOriginalScript && source.ugcOriginalScript.trim().length >= 20
          ? source.ugcOriginalScript
          : null);
      if (!rawInput) {
        throw new NonRetriableError(
          `Concept ${conceptId} has no vision-analyzed metadata or usable original script. ` +
            `Re-run analyze-concept on this concept before submitting.`,
        );
      }
      const userPrompt = composePolish28VariationsUserPrompt(
        rawInput,
        requestedVariantCount,
        MIN_SCRIPT_WORDS,
      );
      const r = await callClaude({
        userId: jobUserId,
        apiKey: keys.claude,
        systemPrompt: POLISH28_VARIATIONS_SYSTEM_PROMPT,
        cacheSystemPrompt: true,
        userMessage: userPrompt,
        maxTokens: 8000,
        generationJobId: data.jobId,
      });
      if (!r.ok || !r.text || r.text.trim().length === 0) {
        throw new NonRetriableError(
          `Claude batch call failed: ${r.errorMessage ?? 'empty response'}`,
        );
      }
      const parsed = parsePolish28VariationsResponse(r.text);
      if (parsed.entries.length === 0) {
        throw new NonRetriableError(
          `Claude returned 0 valid persona+script entries. Errors: ${parsed.errors.slice(0, 5).join(' | ')}`,
        );
      }
      await patchMetadata(data.jobId, {
        polish29_seedance_variations_batch: {
          variations_returned: parsed.entries.length,
          parse_errors: parsed.errors,
          clips_per_variant: clipsPerVariant,
          source_seconds: source.sourceSeconds,
          at: nowIso(),
        },
      });
      return safeInngestStepReturn({ entries: parsed.entries });
    });

    // ---------- F: render each variation in parallel ----------
    const variantResults = await Promise.all(
      variations.entries.map((entry, index) =>
        renderOneVariation({
          step,
          index,
          entry,
          jobId: data.jobId,
          userId: jobUserId,
          dreaminaAccount,
          modelId,
          aspectRatio,
          clipsPerVariant,
          keys,
        }).catch((err) => {
          console.error(`[polish29-seedance-var] variation ${index} failed:`, err);
          return {
            index,
            ok: false as const,
            errorMessage: err instanceof Error ? err.message : String(err),
            creditsSpent: 0,
            clipsSucceeded: 0,
            clipsTotal: clipsPerVariant,
          };
        }),
      ),
    );

    const successful = variantResults.filter((r) => r.ok);
    const failed = variantResults.filter((r) => !r.ok);
    const totalCreditsSpent = variantResults.reduce((sum, r) => sum + (r.creditsSpent ?? 0), 0);

    // ---------- G: mark completed ----------
    await guardedStepRun(step, 'mark-completed', async () => {
      const db = getDb();
      const durationMs = Date.now() - startedAt;
      const anySucceeded = successful.length > 0;
      await db
        .update(schema.generationJobs)
        .set({
          status: anySucceeded ? 'completed' : 'failed',
          completedAt: new Date(),
          generatedCreativeCount: successful.length,
          errorMessage: anySucceeded
            ? null
            : `All ${variantResults.length} variations failed. First error: ${failed[0]?.errorMessage ?? 'unknown'}`,
        })
        .where(eq(schema.generationJobs.id, data.jobId));
      await patchMetadata(data.jobId, {
        polish29_seedance_variations_summary: {
          requested: variations.entries.length,
          succeeded: successful.length,
          failed: failed.length,
          clips_per_variant: clipsPerVariant,
          per_clip_credits: model.credits,
          total_credits_spent: totalCreditsSpent,
          model_id: modelId,
          duration_ms: durationMs,
          at: nowIso(),
          failures: failed.map((r) => ({
            index: r.index,
            errorMessage: r.errorMessage,
            clips_succeeded: r.clipsSucceeded,
            clips_total: r.clipsTotal,
          })),
        },
      });
      return safeInngestStepReturn({ ok: true });
    });

    return {
      jobId: data.jobId,
      generated: successful.length,
      failed: failed.length,
      totalCreditsSpent,
    };
  },
);

// -----------------------------------------------------------------
// Per-variation renderer — the actual multi-clip chain + concat
// -----------------------------------------------------------------

interface RenderOneVariationInput {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  index: number;
  entry: Polish28VariationEntry;
  jobId: string;
  userId: string;
  dreaminaAccount: string;
  modelId: string;
  aspectRatio: '9:16' | '1:1';
  clipsPerVariant: number;
  keys: { claude: string; gemini: string; kling: string };
}

type RenderOneVariationResult =
  | {
      index: number;
      ok: true;
      compositeUrl: string;
      creditsSpent: number;
      clipsSucceeded: number;
      clipsTotal: number;
    }
  | {
      index: number;
      ok: false;
      errorMessage: string;
      creditsSpent: number;
      clipsSucceeded: number;
      clipsTotal: number;
    };

async function renderOneVariation(
  input: RenderOneVariationInput,
): Promise<RenderOneVariationResult> {
  const { step, index, entry, jobId, userId, dreaminaAccount, modelId, aspectRatio, keys } = input;
  const stepSuffix = `v${index}`;

  // 1. Nano Banana Pro character reference PNG. Grey-pixel placeholder
  //    as the required-but-weak ref image (same trick Polish-28
  //    variations uses); the prompt does the character work.
  const character = await guardedStepRun(step, `char-ref-${stepSuffix}`, async () => {
    const personaText =
      `Age: ${entry.persona.age_range}. Gender: ${entry.persona.gender}. ` +
      `Ethnicity: ${entry.persona.ethnicity}. Look: ${entry.persona.look}`;
    const prompt = composeNanoBananaCharacterClonePrompt(personaText);
    const grayPixelPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const r = await cloneCharacterReferenceImage({
      userId,
      apiKey: keys.gemini,
      prompt,
      referenceImageBase64: grayPixelPngBase64,
      referenceImageMimeType: 'image/png',
      generationJobId: jobId,
    });
    if (!r.ok || !r.imageBase64) {
      throw new Error(`Nano Banana character failed: ${r.errorMessage ?? 'unknown'}`);
    }
    const mimeType = r.imageMimeType ?? 'image/png';
    const uploaded = await uploadGeneratedImage({
      userId,
      jobId,
      variantIndex: index,
      imageBase64: r.imageBase64,
      mimeType,
      filenamePrefix: `polish29-var${index}-character-`,
    });
    return safeInngestStepReturn({
      publicUrl: uploaded.publicUrl,
      mimeType,
      base64: r.imageBase64,
    });
  });

  // 1b. Polish-29.0.17 Commit 126: upload the Nano Banana PNG to
  //     Dreamina to obtain the imageRef that Seedance i2v requires
  //     under firstFrameRef. Raw HTTP URLs are not accepted here —
  //     Dreamina must hold the image itself.
  const dreaminaAsset = await guardedStepRun(step, `char-upload-${stepSuffix}`, async () => {
    const bytes = new Uint8Array(Buffer.from(character.base64, 'base64'));
    const r = await uploadUseapiAsset({
      userId,
      service: 'dreamina',
      account: dreaminaAccount,
      bytes,
      contentType: character.mimeType,
      filename: `polish29-var${index}-character.png`,
    });
    if (!r.ok || !r.assetId) {
      throw new Error(
        `Dreamina asset upload failed for character PNG: ${r.errorMessage ?? 'no imageRef in response'}`,
      );
    }
    return safeInngestStepReturn({ imageRef: r.assetId });
  });

  // 2. Split the script into M clip-length segments.
  const clipDialogues = splitScriptIntoClips(entry.script, input.clipsPerVariant);
  if (clipDialogues.length === 0) {
    throw new Error(`variation ${index}: script split produced 0 clips (script too short?)`);
  }
  const personaLockPrefix = composePersonaLockPrefix(entry.persona);

  // 3. Render each clip sequentially. Polish-29.0.23 Commit 132:
  //    CONTINUE past individual clip failures instead of aborting the
  //    whole variation. Dreamina hits content-moderation false-positives
  //    on individual clips (fail_code 2039 etc.); losing 1 out of 4
  //    clips to that shouldn't kill the entire ad. Concat proceeds if
  //    ≥ MIN_CLIPS_TO_CONCAT succeeded (< that = the composite would be
  //    too short to be a usable ad).
  //    InsufficientCreditsError still short-circuits — no point trying
  //    more clips if the wallet is empty.
  const clipUrls: string[] = [];
  const clipFailures: Array<{ clipIndex: number; reason: string; errorMessage: string }> = [];
  let creditsSpent = 0;
  let clipsSucceeded = 0;
  for (let clipIndex = 0; clipIndex < clipDialogues.length; clipIndex++) {
    const dialogue = clipDialogues[clipIndex]!;
    const clipPrompt = composeClipPrompt({
      personaLockPrefix,
      clipDialogue: dialogue,
      clipIndex,
      totalClips: clipDialogues.length,
    });
    const clipResult = await guardedStepRun(step, `clip-${stepSuffix}-${clipIndex}`, async () => {
      try {
        const r = await runSeedanceCreditedJob({
          userId,
          modelId,
          dreaminaAccount,
          prompt: clipPrompt,
          // Polish-29.0.17 Commit 126: pass Dreamina's imageRef under
          // assetId so useapi-net-client maps it to firstFrameRef.
          // The Supabase publicUrl is retained on `character` for the
          // audit trail + generated_creatives.character_reference_url
          // but is NOT sent to Dreamina (they can't fetch it).
          referenceImage: { assetId: dreaminaAsset.imageRef },
          // Ratio auto-derived from firstFrameRef image; don't send it.
          durationSeconds: SEEDANCE_CLIP_SECONDS,
          generationJobId: jobId,
        });
        return safeInngestStepReturn({ kind: 'result' as const, result: r });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return safeInngestStepReturn({
            kind: 'insufficient_credits' as const,
            required: err.required,
            available: err.available,
          });
        }
        throw err;
      }
    });
    if (clipResult.kind === 'insufficient_credits') {
      // Balance exhausted — stop, we can't render more clips. If we
      // already have ≥ MIN clips, fall through to concat them.
      if (clipsSucceeded >= MIN_CLIPS_PER_VARIANT) {
        clipFailures.push({
          clipIndex,
          reason: 'insufficient_credits',
          errorMessage: `Needed ${clipResult.required}, had ${clipResult.available}`,
        });
        break;
      }
      return {
        index,
        ok: false,
        errorMessage: `Insufficient credits at clip ${clipIndex + 1}/${clipDialogues.length}: needed ${clipResult.required}, had ${clipResult.available}. ${clipsSucceeded} clips rendered successfully. Top up on /settings/credits.`,
        creditsSpent,
        clipsSucceeded,
        clipsTotal: clipDialogues.length,
      };
    }
    const seedance = clipResult.result;
    if (seedance.ok !== true) {
      // Log the failure but keep going. Concat step at the end will
      // decide whether we have enough clips to build the composite.
      clipFailures.push({
        clipIndex,
        reason: seedance.reason,
        errorMessage: seedance.errorMessage,
      });
      continue;
    }
    clipUrls.push(seedance.videoUrl);
    creditsSpent += seedance.creditsSpent;
    clipsSucceeded++;
  }

  // Gate concat on having enough clips to be a usable ad. Anything below
  // MIN_CLIPS_PER_VARIANT (currently 2) is too short — fail the variation.
  if (clipsSucceeded < MIN_CLIPS_PER_VARIANT) {
    const failureSummary = clipFailures
      .slice(0, 3)
      .map((f) => `clip ${f.clipIndex + 1}: ${f.reason} — ${f.errorMessage.slice(0, 120)}`)
      .join(' | ');
    return {
      index,
      ok: false,
      errorMessage: `Only ${clipsSucceeded}/${clipDialogues.length} clips rendered — need at least ${MIN_CLIPS_PER_VARIANT} to build a composite. Failures: ${failureSummary}`,
      creditsSpent,
      clipsSucceeded,
      clipsTotal: clipDialogues.length,
    };
  }

  // 4. Concat the M clips via Replicate ffmpeg.
  const concat = await guardedStepRun(step, `concat-${stepSuffix}`, async () => {
    const submit = await submitReplicateConcat({
      userId,
      apiKey: keys.kling,
      videoUrls: clipUrls,
      generationJobId: jobId,
    });
    if (!submit.ok || !submit.predictionId) {
      throw new Error(`Replicate concat submit failed: ${submit.errorMessage ?? 'unknown'}`);
    }
    return safeInngestStepReturn({ predictionId: submit.predictionId });
  });

  // 5. Poll concat until done. Each attempt is its own step for
  //    per-tick Inngest retry + memoization.
  let concatUrl: string | null = null;
  for (let attempt = 0; attempt < CONCAT_POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0)
      await step.sleep(`concat-wait-${stepSuffix}-${attempt}`, `${CONCAT_POLL_INTERVAL_SECONDS}s`);
    const poll = await guardedStepRun(step, `concat-poll-${stepSuffix}-${attempt}`, async () => {
      const r = await checkReplicateConcat({
        userId,
        apiKey: keys.kling,
        predictionId: concat.predictionId,
        generationJobId: jobId,
      });
      return safeInngestStepReturn(r);
    });
    if (poll.status === 'completed' && poll.videoUrl) {
      concatUrl = poll.videoUrl;
      break;
    }
    if (poll.status === 'failed') {
      throw new Error(`Replicate concat failed: ${poll.errorMessage ?? 'unknown'}`);
    }
  }
  if (!concatUrl) {
    throw new Error(
      `Replicate concat did not complete in ${(CONCAT_POLL_MAX_ATTEMPTS * CONCAT_POLL_INTERVAL_SECONDS) / 60} minutes`,
    );
  }

  // 6. Store composite in our bucket.
  const stored = await guardedStepRun(step, `store-composite-${stepSuffix}`, async () => {
    try {
      const r = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: concatUrl!,
        filename: `polish29-seedance-var-${jobId}-${index}.mp4`,
      });
      return safeInngestStepReturn({ kind: 'ok' as const, publicUrl: r.publicUrl });
    } catch (err) {
      return safeInngestStepReturn({
        kind: 'err' as const,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  });
  const finalUrl = stored.kind === 'ok' ? stored.publicUrl : concatUrl;

  // 7. Persist the creative row.
  await guardedStepRun(step, `persist-${stepSuffix}`, async () => {
    const db = getDb();
    await db.insert(schema.generatedCreatives).values({
      userId,
      generationJobId: jobId,
      fileUrl: finalUrl,
      aspectRatio,
      status: 'ready',
      format: 'polish29_seedance_variations',
      hookVariantIndex: index,
      bodyVariantIndex: index,
      ctaVariantIndex: index,
      headline: (entry.persona.age_range + ' ' + entry.persona.gender).slice(0, 200),
      primaryText: entry.script.slice(0, 500),
      generationMetadata: {
        polish29_seedance: true,
        variant_index: index,
        model_id: modelId,
        credits_spent: creditsSpent,
        clips_total: clipDialogues.length,
        clips_succeeded: clipsSucceeded,
        clip_urls_dreamina: clipUrls,
        clip_failures: clipFailures,
        composite_source_url: concatUrl,
        composite_supabase_ok: stored.kind === 'ok',
        composite_supabase_error: stored.kind === 'err' ? stored.errorMessage : null,
        persona: entry.persona,
        character_reference_url: character.publicUrl,
      },
    });
    // Silence a stray unused-var lint if Buffer isn't touched
    // elsewhere: keep the import so future clip-side pre-processing
    // (crop, resize) has ready access.
    void Buffer;
    return safeInngestStepReturn({ ok: true });
  });

  return {
    index,
    ok: true,
    compositeUrl: finalUrl,
    creditsSpent,
    clipsSucceeded,
    clipsTotal: clipDialogues.length,
  };
}
