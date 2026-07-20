/**
 * Polish-23 Commit 3: end-to-end UGC ad worker for the
 * Higgsfield Soul (WaveSpeedAI) + kie.ai Veo 3.1 Lite pipeline.
 *
 * Event: generation/polish23-veo-lite.requested
 *
 * Pipeline (each is an Inngest step.run for retry + caching):
 *   A. Claude ad-spec — { character_lock, segments[N=8] } from
 *      source concept transcription. Persisted to job.metadata.
 *      Wholesale falls back to a Linda-anchored stock ad if
 *      Claude returns un-parseable output (first live test still
 *      exercises end-to-end plumbing).
 *   B. Higgsfield Soul reference PNG via WaveSpeedAI HIGH quality.
 *      One PNG per BATCH — the same URL is threaded into every
 *      Veo clip's imageUrls[] so character consistency is anchored
 *      by first-frame reference.
 *   C. Per-clip Veo Lite loop (8 × 8s clips). Each clip: compose
 *      CHARACTER LOCK prefix → submit → poll → persist kie CDN
 *      URL. Manual 1-retry per segment on non-terminal failure
 *      (the client already handles 429 rate-limits internally).
 *   D. Replicate ffmpeg-concat via Polish-9.12 helper. Feeds
 *      the 8 kie CDN URLs; concat model fetches within the 24-48h
 *      ephemeral window, well inside safe timing.
 *   E. Composite MP4 uploaded to Supabase 'generated-creatives'
 *      bucket (same public-URL path other pipelines use). Insert
 *      generated_creatives row; markJobCompleted.
 *
 * Progress reporting: metadata.polish23_progress patched at each
 * step boundary (5 / 15 / 25 / 25+i/N×60 / 95 / 100). Best-effort
 * — a failed progress patch never fails the pipeline.
 *
 * Character-lock invariants (regression-pinned in the test file):
 *   - character_lock composed ONCE in Step A
 *   - Higgsfield Soul URL generated ONCE in Step B
 *   - Every segment's Veo call uses the identical URL + prefix
 *   - Composite includes 8 clips in submitted order
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  buildKieVeoRequestBody,
  callClaude,
  checkReplicateConcat,
  composeHiggsfieldSoulReferencePrompt,
  composeReferenceImageCaption,
  composeVeoLiteSegmentPrompt,
  KIE_VEO_LITE_DEFAULT_USD_PER_CLIP,
  POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS,
  POLISH23_VEO_SEED_MAX,
  POLISH23_VEO_SEED_MIN,
  pollKieVeoLite,
  pollWavespeedSoul,
  submitKieVeoLite,
  submitReplicateConcat,
  submitWavespeedSoul,
  WAVESPEED_SOUL_USD_PER_RUN,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION, parsePolish23VisionAdditions } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';
import {
  AdSpecSchema,
  POLISH23_SEGMENT_COUNT,
  POLISH23_CLIP_SECONDS,
  assertAllSegmentsValid,
  coalesceAdSpecWithFallback,
  composePolish23AdSpecUserPrompt,
  diagnosePolish23AdSpecParseFailure,
  getPolish23AdSpecSystemPrompt,
  type AdSpec,
  type SegmentSpec,
} from '../lib/polish23-claude-adspec-prompt';

console.log(`[jobs.generate-polish23-veo-lite] cold start — POLISH_VERSION=${POLISH_VERSION}`);

/**
 * Polish-23 Commit 3.0.8: conservative prompt-length ceiling. Veo
 * has an undocumented upstream cap; some clips overrun especially
 * with a rich CHARACTER LOCK prefix + longer scene direction. We
 * warn-and-truncate rather than break — a 3000-char prompt still
 * carries the CHARACTER LOCK invariants and dialogue verbatim.
 */
export const POLISH23_PROMPT_MAX_CHARS = 3000;

/**
 * Polish-23 Commit 3.0.8: soft-truncate a composed prompt to the
 * length ceiling with an explicit marker, so kie.ai / Veo can't
 * silently reject an over-long submission. Returns the possibly-
 * shortened prompt AND a flag so the worker's logs surface when
 * the truncation fired.
 */
export function softTruncatePromptForVeo(
  prompt: string,
  maxChars: number = POLISH23_PROMPT_MAX_CHARS,
): { prompt: string; truncated: boolean; originalChars: number } {
  const originalChars = prompt.length;
  if (originalChars <= maxChars) {
    return { prompt, truncated: false, originalChars };
  }
  const marker = `\n[…truncated at ${maxChars} chars; original was ${originalChars}]`;
  const room = Math.max(0, maxChars - marker.length);
  return { prompt: prompt.slice(0, room) + marker, truncated: true, originalChars };
}

const SOUL_POLL_INTERVAL_SECONDS = 5;
const SOUL_POLL_MAX_ATTEMPTS = 24; // ~2 min
// Polish-23 Commit 3.0.20 → Commit 3.0.21: Veo poll loop uses the
// Inngest step.sleep + step.run per-attempt pattern so each poll
// runs as its own Vercel invocation. No single invocation exceeds
// ~300s, but the TOTAL wait per clip stretches to ~20 min via
// exponential backoff — enough to cover kie.ai's occasional slow
// tail without eating the platform's serverless timeout.
//
// Commit 3.0.21 bumps the cap 20 → 30 attempts. Real kie.ai latency
// variability warrants the extra headroom; the runs are cheap once
// the successFlag=2/3 misread is fixed (see mapKieVeoSuccessFlag).
//
// Backoff schedule (in seconds):
//   attempt 0 →  5s
//   attempt 1 → 10s
//   attempt 2 → 20s
//   attempt 3 → 30s
//   attempts 4-29 → 45s each
// Total worst-case: 5 + 10 + 20 + 30 + 45×26 = 1235s ≈ 20.6 min per clip.
export const VEO_POLL_MAX_ATTEMPTS = 30;
export function computeVeoPollBackoffSeconds(attempt: number): number {
  switch (attempt) {
    case 0:
      return 5;
    case 1:
      return 10;
    case 2:
      return 20;
    case 3:
      return 30;
    default:
      return 45;
  }
}
const CONCAT_POLL_INTERVAL_SECONDS = 5;
const CONCAT_POLL_MAX_ATTEMPTS = 36; // ~3 min
const HIGGSFIELD_SEED_IMAGE_URL =
  process.env['POLISH23_HIGGSFIELD_SEED_IMAGE_URL']?.trim() ||
  // Polish-23 Commit 3.0.13: real root cause of the whole
  // multi-day hotfix cycle was that the Commit-1 placeholder
  // (storage.googleapis.com/higgsfield-public/seed-neutral.png)
  // returned 404. WaveSpeedAI's Higgsfield Soul submit accepted the
  // request with the broken URL, then Soul returned a broken PNG,
  // then kie.ai's Veo generation fetched the broken PNG and
  // returned "please enter prompt" as its generic downstream error.
  //
  // Corrected default: picsum.photos returns a random 1080x1920
  // (9:16 vertical) image on every request, verified 200. Cheap +
  // reliable + zero-auth + no rate-limit concerns for a seed. The
  // prompt does the character work; the seed only conditions
  // Higgsfield Soul on composition + lighting anchors.
  //
  // Operator can override via POLISH23_HIGGSFIELD_SEED_IMAGE_URL env
  // to swap in a preferred reference (e.g. a stored Supabase image
  // matching a specific niche).
  'https://picsum.photos/1080/1920';

export interface Polish23ProgressStep {
  step: string;
  pct: number;
  at: string;
}

/**
 * Compute per-step progress percentages. Anchored on the operator's
 * spec: 5 / 15 / 25 / 25+(N/8)×60 / 95 / 100.
 */
export function computePolish23Progress(
  step: 'analyze-concept' | 'claude-ad-spec' | 'higgsfield-soul' | 'concat' | 'upload' | 'complete',
  segmentIndex?: number,
): number {
  switch (step) {
    case 'analyze-concept':
      return 5;
    case 'claude-ad-spec':
      return 15;
    case 'higgsfield-soul':
      return 25;
    case 'concat':
      return 95;
    case 'upload':
      return 100;
    case 'complete':
      return 100;
  }
  void segmentIndex;
  return 0;
}

/** Segment progress: 25 + ((segmentIndex + 1) / N) × 60, clamped [25, 85]. */
export function computePolish23SegmentProgress(segmentIndex: number, total: number): number {
  const t = Math.max(1, total);
  const pct = 25 + ((segmentIndex + 1) / t) * 60;
  return Math.max(25, Math.min(85, Math.round(pct)));
}

export const generatePolish23VeoLite = inngest.createFunction(
  {
    id: 'generate-polish23-veo-lite',
    name: 'Polish-23: Higgsfield Soul + kie.ai Veo 3.1 Lite UGC ad',
    // Function-level retry ONE — segment-level manual retry lives
    // inside the loop below.
    retries: 1,
  },
  { event: 'generation/polish23-veo-lite.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    // -------- Load job --------
    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { variantCount: true, metadata: true, conceptIds: true },
      });
    });
    if (!job) {
      await markJobFailed(jobId, userId, 'Job not found', 0);
      return { jobId, mode, generated: 0 };
    }

    // Mark processing + emit initial progress in a single step.
    await step.run('mark-processing', async () => {
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          status: 'processing',
          metadata: {
            ...meta,
            polish23_progress: {
              step: 'analyze-concept',
              pct: computePolish23Progress('analyze-concept'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // -------- Source concept context --------
    // Polish-23 Commit 3.0.19: source-priority chain, best → worst:
    //   (1) concepts.metadata.analysis.persona (+ setting_details +
    //       emotional_arc + hook_structure + niche_category from
    //       POLISH23_VISION_SYSTEM_PROMPT) — vision analysis run
    //       against the source video. STRUCTURED persona class the
    //       Claude ad-spec + Higgsfield Soul prompt use to mirror
    //       source persona. HIGHEST — this is the correct signal.
    //   (2) concepts.ugc_original_script — direct user paste at
    //       concept-upload time. No transcription loss but no
    //       persona info; Claude has to guess.
    //   (3) most recent PRIOR completed job's metadata.analysis —
    //       Polish-21 UGC_DECONSTRUCTOR output.
    //   (4) this-job's metadata.analysis.script_transcription —
    //       same-job legacy path (analyze-concept ran but no
    //       persona schema).
    //   (5) 'linda_fallback' → Linda-anchored generic ad.
    //
    // Single step.run so DB reads for (1)/(2)/(3) share one Inngest
    // cache boundary. Returns a discriminated shape so the caller
    // can log which source won.
    const conceptId = job.conceptIds?.[0];
    const sourceLookup = conceptId
      ? await step.run('load-concept-source-context', async () => {
          const db = getDb();
          // (1) concepts.metadata.analysis with Polish-23 persona
          const concept = await db.query.concepts.findFirst({
            where: eq(schema.concepts.id, conceptId),
            columns: { ugcOriginalScript: true, contentType: true, metadata: true },
          });
          const conceptMeta = (concept?.metadata as Record<string, unknown> | null) ?? null;
          const conceptAnalysis = conceptMeta?.['analysis'] ?? null;
          if (conceptAnalysis && typeof conceptAnalysis === 'object') {
            const visionAdditions = parsePolish23VisionAdditions(conceptAnalysis);
            if (visionAdditions) {
              return {
                source: 'vision_analysis_persona' as const,
                text: JSON.stringify(conceptAnalysis, null, 2),
                persona: visionAdditions.persona,
                jobId: null as string | null,
              };
            }
          }
          // (2) concepts.ugc_original_script
          const ugcScript = concept?.ugcOriginalScript ?? null;
          if (ugcScript && ugcScript.trim().length > 0) {
            return {
              source: 'ugc_original_script' as const,
              text: ugcScript,
              persona: null,
              jobId: null as string | null,
            };
          }
          // (3) prior job's metadata.analysis
          const priors = await db.query.generationJobs.findMany({
            where: eq(schema.generationJobs.status, 'completed'),
            columns: { id: true, metadata: true, completedAt: true, conceptIds: true },
            orderBy: (t, { desc }) => [desc(t.completedAt)],
            limit: 25,
          });
          for (const p of priors) {
            const ids = (p.conceptIds ?? []) as string[];
            if (!ids.includes(conceptId)) continue;
            const meta = (p.metadata ?? null) as Record<string, unknown> | null;
            const analysis = meta?.['analysis'] ?? null;
            if (analysis && typeof analysis === 'object') {
              return {
                source: 'prior_analysis' as const,
                text: JSON.stringify(analysis, null, 2),
                persona: null,
                jobId: p.id as string | null,
              };
            }
          }
          return {
            source: 'none' as const,
            text: null as string | null,
            persona: null,
            jobId: null as string | null,
          };
        })
      : {
          source: 'none' as const,
          text: null as string | null,
          persona: null,
          jobId: null as string | null,
        };

    // Polish-23 Commit 3.0.19: explicit final-source tag now
    // includes 'vision_analysis_persona' as the highest-signal
    // branch. Tag matches operator's spec:
    //   'vision_analysis_persona' | 'ugc_original_script'
    //   | 'prior_analysis' | 'legacy_transcription' | 'linda_fallback'
    let sourceContext: string;
    let finalSourceTag:
      | 'vision_analysis_persona'
      | 'ugc_original_script'
      | 'prior_analysis'
      | 'legacy_transcription'
      | 'linda_fallback';
    if (sourceLookup.source === 'vision_analysis_persona' && sourceLookup.text) {
      sourceContext = sourceLookup.text;
      finalSourceTag = 'vision_analysis_persona';
      console.log(
        `[polish-23-worker] source context: concepts.metadata.analysis.persona ` +
          `(POLISH23_VISION_SYSTEM_PROMPT output, ${sourceContext.length} chars, ` +
          `persona.gender=${sourceLookup.persona?.gender}, ` +
          `persona.age_range=${sourceLookup.persona?.age_range})`,
      );
    } else if (sourceLookup.source === 'ugc_original_script' && sourceLookup.text) {
      sourceContext = sourceLookup.text;
      finalSourceTag = 'ugc_original_script';
      console.log(
        `[polish-23-worker] source context: concepts.ugc_original_script ` +
          `(direct user paste, ${sourceContext.length} chars)`,
      );
    } else if (sourceLookup.source === 'prior_analysis' && sourceLookup.text) {
      sourceContext = sourceLookup.text;
      finalSourceTag = 'prior_analysis';
      console.log(
        `[polish-23-worker] source context: prior job ${sourceLookup.jobId} ` +
          `metadata.analysis (${sourceContext.length} chars)`,
      );
    } else {
      const legacyJobScript = extractSourceScript(job.metadata as Record<string, unknown> | null);
      if (legacyJobScript) {
        sourceContext = legacyJobScript;
        finalSourceTag = 'legacy_transcription';
        console.log(
          `[polish-23-worker] source context: this-job.metadata.analysis.script_transcription ` +
            `(${legacyJobScript.length} chars)`,
        );
      } else {
        sourceContext = '(no source analysis available)';
        finalSourceTag = 'linda_fallback';
        console.warn(
          `[polish-23-worker] source context: linda_fallback — no vision analysis or ` +
            `ugc_original_script on concept ${conceptId ?? '(unknown)'}, no prior analyzed ` +
            `job, no legacy this-job analysis. Claude will produce a generic Linda ad.`,
        );
      }
    }

    // Polish-23 Commit 3.0.19: prepend a PERSONA MIRROR block to
    // the source context when vision persona is available. Claude
    // reads this ABOVE the analysis JSON so its character_lock
    // generation locks to the source persona CLASS (not identity).
    // Polish-23 Commit 3.0.25: PERSONA MIRROR block rewritten as
    // a HARD CONSTRAINT with per-field requirements. Prior text
    // said "MUST match this persona CLASS (not identity)" but
    // Claude's ad-spec output was still landing on Linda when the
    // source persona was male. New phrasing hits each character_lock
    // field individually (gender, age, demographic_role, name)
    // with imperative REJECT/DO-NOT language + explicit failure-
    // mode framing so Claude can't attention-average it out.
    const sourceScript =
      sourceLookup.source === 'vision_analysis_persona' && sourceLookup.persona
        ? `===== PERSONA MIRROR (HARD CONSTRAINT) =====\n` +
          `Source video vision analysis extracted this persona. The character_lock you ` +
          `generate MUST match ALL of these fields verbatim:\n` +
          `  gender: ${sourceLookup.persona.gender}\n` +
          `  age_range: ${sourceLookup.persona.age_range}\n` +
          `  ethnicity: ${sourceLookup.persona.ethnicity}\n` +
          `  look: ${sourceLookup.persona.look}\n` +
          `  voice_tone: ${sourceLookup.persona.voice_tone}\n` +
          `\n` +
          `PER-FIELD REQUIREMENTS (each is a HARD CONSTRAINT):\n` +
          `  1. character_lock.gender MUST equal "${sourceLookup.persona.gender}". ` +
          `DO NOT flip gender. A wrong gender is a total pipeline failure.\n` +
          `  2. character_lock.age MUST fall inside the ${sourceLookup.persona.age_range} range.\n` +
          `  3. character_lock.demographic_role MUST describe a ${sourceLookup.persona.gender} ` +
          `${sourceLookup.persona.ethnicity} person in the ${sourceLookup.persona.age_range} bracket. ` +
          `Not a "suburban grandmother" unless the source persona actually is one.\n` +
          `  4. character_lock.name MUST be a common first name for a ${sourceLookup.persona.gender} ` +
          `${sourceLookup.persona.ethnicity}. Do NOT reuse "Linda".\n` +
          `  5. All anti_celeb_*_examples lists MUST reflect a ${sourceLookup.persona.gender} ` +
          `${sourceLookup.persona.ethnicity} in the ${sourceLookup.persona.age_range} bracket ` +
          `(not the Linda default).\n` +
          `\n` +
          `REJECT the default Linda anchor (68yo American female suburban grandmother) ` +
          `unless the source persona is literally female + age_range 60-70 + white/other ` +
          `Linda-shaped. Any Linda output on a non-Linda source persona is a HARD FAIL.\n` +
          `\n` +
          `===== SOURCE VIDEO VISION ANALYSIS (JSON) =====\n\n${sourceContext}`
        : sourceContext;

    // Polish-23 Commit 3.0.16: metadata.polish23_source_context —
    // durable evidence of which branch fed Claude. Field name matches
    // operator's spec (was polish23_source_context_lookup in 3.0.15).
    // Query with:
    //   SELECT jsonb_pretty(metadata->'polish23_source_context')
    //     FROM generation_jobs WHERE id = '<jobId>';
    await step.run('persist-source-context', async () => {
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      const textChars = sourceContext.length;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            polish23_source_context: {
              conceptId: conceptId ?? null,
              source: finalSourceTag,
              priorJobId: sourceLookup.jobId,
              textChars,
              textHead: sourceContext.slice(0, 200),
              textTail: sourceContext.slice(-200),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // -------- Step A: Claude ad-spec --------
    // Polish-23 Commit 3.0.2: Step A returns an enriched shape so
    // the persist step can write durable forensics (raw Claude text
    // excerpt + parse diagnostic + segment fallback tracking) to
    // job.metadata. BCH's stack is new territory; production
    // forensics beat re-running the pipeline to reproduce.
    //
    // Polish-23 Commit 3.0.24: dedicated forensic fields for the
    // "Linda fallback fired despite vision persona extracted"
    // investigation. Every fallback path now writes:
    //   - polish23_claude_adspec_request (userMessage LEFT 4000)
    //   - polish23_claude_adspec_raw_response (rawText LEFT 4000)
    //   - polish23_claude_parsed_character_lock (parsed CL or null)
    //   - polish23_character_lock_fallback_reason (why fallback
    //     fired; null on the healthy parse path)
    // + loud-log of all four for Vercel Runtime Logs.
    const claudeUserMessage = composePolish23AdSpecUserPrompt(sourceScript || '(no source script)');
    const claudeUserMessageExcerpt = claudeUserMessage.slice(0, 4000);
    // Polish-23 Commit 3.0.28: PERSONA-MIRROR MODE system prompt.
    // SQL forensics (metadata.polish23_claude_parsed_character_lock)
    // confirmed the mirror reached Claude with all HARD CONSTRAINT
    // language intact — but Claude still returned Linda because the
    // Linda-shaped bullet examples in the fallback system prompt
    // dominated the user-message mirror. Fix: when a persona is
    // available, hand Claude a system prompt that OMITS every Linda
    // template — the character comes entirely from the user-message
    // mirror block with no competing system-prompt anchor.
    const hasPersonaMirror =
      sourceLookup.source === 'vision_analysis_persona' && !!sourceLookup.persona;
    const claudeSystemPrompt = getPolish23AdSpecSystemPrompt({ hasPersonaMirror });
    console.log(
      `[polish-23-worker Step A] Claude systemPrompt mode: ` +
        `hasPersonaMirror=${hasPersonaMirror} ` +
        `systemPrompt_chars=${claudeSystemPrompt.length}`,
    );
    console.log(
      `[polish-23-worker Step A] Claude userMessage (LEFT 4000, ` +
        `total_chars=${claudeUserMessage.length}): ${claudeUserMessageExcerpt}`,
    );
    const stepAResult = await step.run('claude-ad-spec', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          const fallbackReason = `claude-key-missing: ${(err as Error).message.slice(0, 400)}`;
          console.warn(
            `[polish-23-worker Step A] Claude key missing — wholesale fallback to Linda. ` +
              `polish23_character_lock_fallback_reason=${JSON.stringify(fallbackReason)} ` +
              `polish23_claude_parsed_character_lock=null`,
          );
          const coalesced = coalesceAdSpecWithFallback(null);
          return {
            adSpec: coalesced.adSpec,
            metadataExtras: {
              polish23_claude_adspec_system_prompt_mode: hasPersonaMirror
                ? 'persona-mirror'
                : 'fallback-linda',
              polish23_claude_adspec_request: claudeUserMessageExcerpt,
              polish23_claude_adspec_raw_response: null,
              polish23_claude_parsed_character_lock: null,
              polish23_character_lock_fallback_reason: fallbackReason,
              polish23_claude_raw_text: null,
              polish23_parse_diagnostic: {
                reason: 'claude-key-missing',
                detail: (err as Error).message.slice(0, 400),
              },
              polish23_segments_fallback_used: coalesced.segmentFallbackIndices,
              polish23_wholesale_fallback: coalesced.wholesaleFallback,
            },
          };
        }
        throw err;
      }
      const r = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt: claudeSystemPrompt,
        userMessage: claudeUserMessage,
        maxTokens: 4096,
        generationJobId: jobId,
      });
      const rawText = r.text ?? '';
      const rawTextExcerpt = rawText.slice(0, 4000);
      // Loud-log the FULL raw Claude response (first 4000 chars)
      // BEFORE the parse attempt so any parse failure surfaces the
      // actual response text in Inngest logs immediately.
      console.log(
        `[polish-23-worker Step A] Claude raw response ok=${r.ok} chars=${rawText.length}: ` +
          `${rawTextExcerpt}`,
      );

      if (!r.ok) {
        const fallbackReason = `claude-call-failed: ${(r.errorMessage ?? '').slice(0, 400)}`;
        console.warn(
          `[polish-23-worker Step A] Claude ad-spec call failed (${r.errorMessage}) — ` +
            'wholesale fallback to Linda + stock ad. ' +
            `polish23_character_lock_fallback_reason=${JSON.stringify(fallbackReason)} ` +
            `polish23_claude_parsed_character_lock=null`,
        );
        const coalesced = coalesceAdSpecWithFallback(null);
        return {
          adSpec: coalesced.adSpec,
          metadataExtras: {
            polish23_claude_adspec_system_prompt_mode: hasPersonaMirror
              ? 'persona-mirror'
              : 'fallback-linda',
            polish23_claude_adspec_request: claudeUserMessageExcerpt,
            polish23_claude_adspec_raw_response: rawTextExcerpt,
            polish23_claude_parsed_character_lock: null,
            polish23_character_lock_fallback_reason: fallbackReason,
            polish23_claude_raw_text: rawTextExcerpt,
            polish23_parse_diagnostic: {
              reason: 'claude-call-failed',
              detail: (r.errorMessage ?? '').slice(0, 400),
            },
            polish23_segments_fallback_used: coalesced.segmentFallbackIndices,
            polish23_wholesale_fallback: coalesced.wholesaleFallback,
          },
        };
      }

      // Diagnostic parse — names WHY it failed if it does.
      const diag = diagnosePolish23AdSpecParseFailure(rawText);
      const parseDiagnostic = diag.ok
        ? { reason: 'success' as const, detail: null as string | null }
        : { reason: diag.reason, detail: diag.detail ?? null };
      const parsed = diag.ok ? diag.data : null;
      const parsedCharacterLock = diag.ok ? diag.data.character_lock : null;

      if (!diag.ok) {
        const fallbackReason = `parse-failed: reason=${diag.reason} detail=${diag.detail ?? '(none)'}`;
        console.warn(
          `[polish-23-worker Step A] Claude ad-spec parse failed: reason=${diag.reason} ` +
            `detail=${diag.detail ?? '(none)'}. Wholesale fallback fires. ` +
            `polish23_character_lock_fallback_reason=${JSON.stringify(fallbackReason)} ` +
            `polish23_claude_parsed_character_lock=null`,
        );
      } else {
        console.log(
          `[polish-23-worker Step A] Claude ad-spec parsed OK. ` +
            `polish23_claude_parsed_character_lock={` +
            `name=${diag.data.character_lock.name},` +
            `age=${diag.data.character_lock.age},` +
            `gender=${diag.data.character_lock.gender},` +
            `demographic_role=${JSON.stringify(diag.data.character_lock.demographic_role)}} ` +
            `segments=${diag.data.segments.length} ` +
            `polish23_character_lock_fallback_reason=null`,
        );
      }

      // Safety-net coalesce runs regardless. In the healthy parse
      // path it's a no-op (identity return). In the failure path it
      // wholesale-fills. In the theoretical partial-drift path it
      // per-index backfills and tracks the offending indices.
      const coalesced = coalesceAdSpecWithFallback(parsed);
      let coalesceFallbackReason: string | null = null;
      if (coalesced.wholesaleFallback) {
        coalesceFallbackReason = `wholesale-fallback: parsed=null (see polish23_parse_diagnostic for the underlying reason)`;
      } else if (coalesced.segmentFallbackIndices.length > 0) {
        coalesceFallbackReason = `per-segment-fallback: indices=[${coalesced.segmentFallbackIndices.join(', ')}]`;
      }
      if (coalesced.segmentFallbackIndices.length > 0) {
        console.warn(
          `[polish-23-worker Step A] Safety-net per-segment fallback fired for indices: ` +
            `[${coalesced.segmentFallbackIndices.join(', ')}]. Parser SHOULD have caught this — ` +
            'investigate a schema loosening or in-memory mutation.',
        );
      }

      // Compose final polish23_character_lock_fallback_reason from
      // whichever branch fired (parse failure OR coalesce fallback).
      // Null on the true happy path (parse ok, no coalescer fill).
      const finalFallbackReason: string | null = !diag.ok
        ? `parse-failed: reason=${diag.reason} detail=${diag.detail ?? '(none)'}`
        : coalesceFallbackReason;

      return {
        adSpec: coalesced.adSpec,
        metadataExtras: {
          polish23_claude_adspec_request: claudeUserMessageExcerpt,
          polish23_claude_adspec_raw_response: rawTextExcerpt,
          polish23_claude_parsed_character_lock: parsedCharacterLock,
          polish23_character_lock_fallback_reason: finalFallbackReason,
          polish23_claude_raw_text: rawTextExcerpt,
          polish23_parse_diagnostic: parseDiagnostic,
          polish23_segments_fallback_used: coalesced.segmentFallbackIndices,
          polish23_wholesale_fallback: coalesced.wholesaleFallback,
        },
      };
    });
    const adSpec = stepAResult.adSpec;
    const metadataExtras = stepAResult.metadataExtras;

    // Polish-23 Commit 3.0.1: paranoid triple-check pre-Step-C. The
    // coalescer above already backfills any invalid segment from
    // the fallback, so this should be dead code in every healthy
    // path. Kept as a definitive fail-fast if the fallback itself
    // is somehow corrupt (impossible per test suite).
    try {
      assertAllSegmentsValid(adSpec.segments);
      if (adSpec.character_lock == null || typeof adSpec.character_lock.name !== 'string') {
        throw new Error(
          '[polish-23-worker] AdSpec.character_lock is missing or malformed after coalesce. ' +
            'This should be unreachable — investigate a corrupt fallbackPolish23AdSpec.',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[polish-23-worker Step A → invariant guard] ${msg}`);
      await markJobFailed(jobId, userId, msg, 0);
      return { jobId, mode, generated: 0 };
    }

    // Persist character_lock + segments to job.metadata + progress bump.
    await step.run('persist-ad-spec', async () => {
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            ...metadataExtras,
            polish23_progress: {
              step: 'claude-ad-spec',
              pct: computePolish23Progress('claude-ad-spec'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // Warn on word-count drift (informational; worker proceeds).
    for (let i = 0; i < adSpec.segments.length; i++) {
      const wc = adSpec.segments[i]!.dialogue.trim().split(/\s+/).filter(Boolean).length;
      if (wc < 20 || wc > 24) {
        console.log(
          `[polish-23-worker] segment ${i} word-count drift: ${wc} outside [20,24]. ` +
            `Proceeding (worker warn-and-proceed policy).`,
        );
      }
    }

    // -------- Step B pre-check: Higgsfield seed URL health --------
    // Polish-23 Commit 3.0.13: the real root cause of the whole
    // multi-day debug cycle was that the Commit-1 placeholder seed
    // URL returned 404. Higgsfield Soul accepted the broken URL,
    // produced a broken PNG, then kie.ai's Veo fetched the broken
    // PNG and returned an opaque "Please enter prompt" — surface
    // that class of failure HERE with a definitive error message
    // so the operator can flip the env var in 30 seconds instead
    // of chasing symptoms downstream.
    //
    // Polish-23 Commit 3.0.14: uses GET instead of HEAD. picsum.photos
    // (the operator's confirmed working seed host) returns 405 on
    // HEAD but 200 on GET; real image CDNs commonly restrict HEAD.
    // Trust GET as the ground-truth method Higgsfield Soul itself
    // will use. Body stream is cancelled immediately after the
    // status arrives, so the check remains cheap (~one TCP round-
    // trip, no image download).
    await step.run('higgsfield-seed-url-health-check', async () => {
      let statusCode: number | null = null;
      let networkError: string | null = null;
      try {
        const res = await fetch(HIGGSFIELD_SEED_IMAGE_URL, { method: 'GET' });
        statusCode = res.status;
        // Abort the body stream — we only needed the status.
        await res.body?.cancel();
      } catch (err) {
        networkError = err instanceof Error ? err.message : String(err);
      }
      const checkResult = {
        url: HIGGSFIELD_SEED_IMAGE_URL,
        method: 'GET' as const,
        statusCode,
        networkError,
        ok: networkError === null && statusCode !== null && statusCode >= 200 && statusCode < 400,
        at: new Date().toISOString(),
      };
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            ...metadataExtras,
            polish23_higgsfield_seed_url_check: checkResult,
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
      if (networkError !== null) {
        throw new NonRetriableError(
          `Higgsfield seed URL unreachable: ${HIGGSFIELD_SEED_IMAGE_URL} — ` +
            `network error: ${networkError}. ` +
            `Set POLISH23_HIGGSFIELD_SEED_IMAGE_URL to a valid image URL (e.g. ` +
            `https://picsum.photos/1080/1920) on Vercel and redeploy.`,
        );
      }
      // Polish-23 Commit 3.0.14: accept 2xx AND 3xx (fetch follows
      // redirects by default so 3xx is rare here, but a proxied
      // seed CDN could legitimately return one before the client
      // resolves the redirect).
      if (statusCode === null || statusCode < 200 || statusCode >= 400) {
        throw new NonRetriableError(
          `Higgsfield seed URL unreachable: ${HIGGSFIELD_SEED_IMAGE_URL} returned ${statusCode}. ` +
            `Set POLISH23_HIGGSFIELD_SEED_IMAGE_URL to a valid image URL (e.g. ` +
            `https://picsum.photos/1080/1920) on Vercel and redeploy.`,
        );
      }
      console.log(
        `[polish-23-worker] higgsfield-seed-url-health-check: ` +
          `${HIGGSFIELD_SEED_IMAGE_URL} → ${statusCode} OK`,
      );
    });

    // -------- Step B: Higgsfield Soul reference PNG --------
    const soulRefUrl = await step.run('higgsfield-soul', async () => {
      const keys = await loadDecryptedKeys(userId, ['wavespeed_ai']);
      const submit = await submitWavespeedSoul({
        userId,
        apiKey: keys.wavespeed_ai!,
        prompt: composeHiggsfieldSoulReferencePrompt(adSpec.character_lock),
        image: HIGGSFIELD_SEED_IMAGE_URL,
        quality: 'high',
        generationJobId: jobId,
      });
      if (!submit.ok || !submit.predictionId) {
        throw new Error(`WaveSpeedAI submit failed: ${submit.errorMessage ?? 'unknown'}`);
      }
      const predictionId = submit.predictionId;
      let outputUrl: string | undefined;
      for (let attempt = 0; attempt < SOUL_POLL_MAX_ATTEMPTS; attempt++) {
        await sleep(SOUL_POLL_INTERVAL_SECONDS * 1000);
        const poll = await pollWavespeedSoul({
          userId,
          apiKey: keys.wavespeed_ai!,
          predictionId,
          generationJobId: jobId,
        });
        if (!poll.ok) {
          throw new Error(`WaveSpeedAI poll failed: ${poll.errorMessage ?? 'unknown'}`);
        }
        if (poll.status === 'failed' || poll.status === 'cancelled') {
          throw new Error(
            `WaveSpeedAI Higgsfield Soul terminal ${poll.status}: ${poll.errorMessage ?? '(no msg)'}`,
          );
        }
        if (poll.status === 'completed') {
          outputUrl = poll.outputUrl;
          break;
        }
      }
      if (!outputUrl) {
        throw new Error(
          `WaveSpeedAI Higgsfield Soul didn't complete within ` +
            `${SOUL_POLL_MAX_ATTEMPTS * SOUL_POLL_INTERVAL_SECONDS}s.`,
        );
      }
      // Re-upload to Supabase for a stable URL kie.ai will fetch.
      const download = await fetch(outputUrl);
      if (!download.ok) {
        throw new Error(`Failed to download Higgsfield Soul PNG: HTTP ${download.status}`);
      }
      const bytes = new Uint8Array(await download.arrayBuffer());
      const base64 = Buffer.from(bytes).toString('base64');
      const upload = await uploadGeneratedImage({
        userId,
        jobId,
        variantIndex: 0,
        imageBase64: base64,
        mimeType: 'image/png',
        filenamePrefix: 'polish23-soul-ref',
      });
      return upload.publicUrl;
    });

    // Persist Soul URL + progress bump.
    await step.run('persist-soul-ref', async () => {
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            ...metadataExtras,
            higgsfield_soul_ref_url: soulRefUrl,
            polish23_progress: {
              step: 'higgsfield-soul',
              pct: computePolish23Progress('higgsfield-soul'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // Polish-23 Commit 3.0.27: derive + persist the batch-scoped
    // Veo seed ONCE, wrapped in step.run so Inngest caches it. On
    // any function-level retry OR clip-level auto-retry (Commit
    // 3.0.22), the cached seed is returned and the SAME value flows
    // into every Veo submit — that's the point per kie.ai's docs.
    //
    // Range 10000-99999 per kie.ai's documented `seeds` field.
    // Also persist the composed reference-image caption for SQL
    // forensics + downstream reuse.
    const polish23Seed = await step.run('generate-polish23-seed', async () => {
      const seed =
        POLISH23_VEO_SEED_MIN +
        Math.floor(Math.random() * (POLISH23_VEO_SEED_MAX - POLISH23_VEO_SEED_MIN + 1));
      const referenceCaption = composeReferenceImageCaption(adSpec.character_lock);
      const db = getDb();
      const row = await db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { metadata: true },
      });
      const meta = (row?.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            polish23_seed: seed,
            polish23_reference_image_caption: referenceCaption,
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
      console.log(
        `[polish-23-worker] batch seed generated: polish23_seed=${seed} ` +
          `polish23_reference_image_caption=${JSON.stringify(referenceCaption).slice(0, 400)}`,
      );
      return seed;
    });

    // Polish-23 Commit 3.0.8: soul-ref URL health check. Before we
    // spend Veo credits on 8 clips that all reference this PNG, do
    // a cheap HEAD to confirm kie.ai (or Replicate concat, or any
    // downstream) can fetch it. Non-2xx → NonRetriableError with
    // the URL + status code baked into the message; status also
    // persisted to metadata.polish23_higgsfield_reference_url_status
    // for durable inspection via the operator's SQL query.
    await step.run('soul-ref-health-check', async () => {
      let statusCode: number | null = null;
      let networkError: string | null = null;
      try {
        const head = await fetch(soulRefUrl, { method: 'HEAD' });
        statusCode = head.status;
      } catch (err) {
        networkError = err instanceof Error ? err.message : String(err);
      }
      const db = getDb();
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            ...metadataExtras,
            higgsfield_soul_ref_url: soulRefUrl,
            polish23_higgsfield_reference_url_status:
              statusCode !== null ? String(statusCode) : `network-error: ${networkError}`,
            polish23_progress: {
              step: 'soul-ref-health-check',
              pct: computePolish23Progress('higgsfield-soul'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
      if (networkError !== null) {
        throw new NonRetriableError(
          `Higgsfield Soul reference URL fetch failed (${soulRefUrl}): ${networkError}. ` +
            `Downstream kie.ai + Replicate will fail identically — aborting before Veo credits burn.`,
        );
      }
      if (statusCode === null || statusCode < 200 || statusCode >= 300) {
        throw new NonRetriableError(
          `Higgsfield Soul reference URL is not reachable (${soulRefUrl}, HTTP ${statusCode}). ` +
            `Downstream kie.ai + Replicate will fail identically — aborting before Veo credits burn.`,
        );
      }
    });

    // -------- Step C: Per-clip Veo Lite loop --------
    const clipUrls: string[] = [];
    // Polish-23 Commit 3.0.3: durable forensics — every composed
    // Veo prompt is captured here, then persisted to
    // job.metadata.polish23_composed_prompts on each per-clip
    // progress patch. A future "empty prompt reached kie.ai"
    // report can be verified by reading the metadata row — no
    // more guessing whether the composer or the wire layer was
    // at fault.
    const composedPrompts: Array<{
      segmentIndex: number;
      wordCount: number;
      promptChars: number;
      prompt: string;
    }> = [];
    // Polish-23 Commit 3.0.4: capture the EXACT wire body sent to
    // kie.ai per clip (via buildKieVeoRequestBody, same builder
    // submitKieVeoLite uses internally — zero drift risk). Persisted
    // to metadata.polish23_veo_submit_bodies so a SQL query on the
    // failing row shows the exact shape kie.ai received.
    const veoSubmitBodies: Array<{
      segmentIndex: number;
      body: Record<string, unknown>;
    }> = [];
    // Polish-23 Commit 3.0.9 → 3.0.20: durable per-poll response
    // persistence still happens, but the append is now done INSIDE
    // each veo-clip-i-poll-attempt step.run body (append-safe read-
    // modify-write against metadata). No outer-closure array needed
    // because each poll runs in its own Vercel invocation — an
    // outer-closure array would only survive within a single
    // invocation, which the new sleep-poll layout deliberately does
    // NOT rely on.
    for (let i = 0; i < adSpec.segments.length; i++) {
      const segment = adSpec.segments[i]!;
      const composed = composeVeoLiteSegmentPrompt(adSpec.character_lock, {
        segmentIndex: i,
        totalSegments: POLISH23_SEGMENT_COUNT,
        dialogue: segment.dialogue,
        sceneDirection: segment.sceneDirection,
        emotionalBeat: segment.emotionalBeat,
      });
      // Polish-23 Commit 3.0.8: prompt-length instrumentation +
      // soft-truncate. A 3000-char ceiling keeps the CHARACTER
      // LOCK prefix + dialogue intact; anything longer risks
      // silent kie.ai/Veo rejection with no useful error message.
      const truncated = softTruncatePromptForVeo(composed.prompt);
      if (truncated.truncated) {
        console.warn(
          `[polish-23-worker Step C] veo-clip-${i} PROMPT TRUNCATED: ` +
            `original=${truncated.originalChars} chars, sent=${truncated.prompt.length} chars. ` +
            `Investigate composer output growth if this fires often.`,
        );
      }
      // Polish-23 Commit 3.0.12: SHA-256 + head/tail computed above
      // and also persisted here so an SQL query on the job row
      // returns them without needing Vercel Runtime Log access.
      const composedPromptRecord = {
        segmentIndex: i,
        wordCount: composed.wordCountCheck.wordCount,
        promptChars: truncated.prompt.length,
        originalChars: truncated.originalChars,
        truncated: truncated.truncated,
        promptSha256: createHash('sha256').update(truncated.prompt).digest('hex'),
        promptHead: truncated.prompt.slice(0, 100),
        promptTail: truncated.prompt.slice(-100),
        prompt: truncated.prompt.slice(0, 3000),
      };
      composedPrompts.push(composedPromptRecord);
      // Polish-23 Commit 3.0.12: repeatability + head/tail
      // instrumentation. SHA-256 lets the operator confirm two
      // runs produced identical prompts (or diff them if not).
      // Head/tail 100 chars surface CHARACTER LOCK prefix +
      // anti-AI directive tail without the middle content flooding
      // Vercel Runtime Logs.
      const promptHash = createHash('sha256').update(truncated.prompt).digest('hex');
      const promptHead = truncated.prompt.slice(0, 100);
      const promptTail = truncated.prompt.slice(-100);
      console.log(
        `[polish-23-worker Step C] veo-clip-${i} composed prompt ` +
          `chars=${truncated.prompt.length} (original=${truncated.originalChars}) ` +
          `truncated=${truncated.truncated} ` +
          `words=${composed.wordCountCheck.wordCount} ` +
          `sha256=${promptHash} ` +
          `head=${JSON.stringify(promptHead)} tail=${JSON.stringify(promptTail)}`,
      );
      // Full prompt on a separate line so grep + copy-paste from
      // Vercel Runtime Logs stays workable.
      console.log(
        `[polish-23-worker Step C] veo-clip-${i} composed prompt (full): ` +
          `${truncated.prompt.slice(0, 3000)}`,
      );
      if (composed.prompt.trim().length === 0) {
        console.error(
          `[polish-23-worker Step C] veo-clip-${i} COMPOSER PRODUCED EMPTY PROMPT — this should be impossible. ` +
            `Aborting job before Veo credits are spent.`,
        );
        await markJobFailed(
          jobId,
          userId,
          `composeVeoLiteSegmentPrompt returned empty for segment ${i} — investigate composer regression.`,
          0,
        );
        return { jobId, mode, generated: 0 };
      }

      // Polish-23 Commit 3.0.5: build + push the wire body OUTSIDE
      // the veo-clip step so the outer-closure array is populated
      // deterministically BEFORE the risky submit step runs. Prior
      // to this, capturedBody was pushed inside step.run — when the
      // step threw, the in-memory push survived but the persist
      // step that would have written it downstream never ran.
      const capturedBody = buildKieVeoRequestBody({
        userId,
        apiKey: '',
        prompt: truncated.prompt,
        aspectRatio: '9:16',
        imageUrls: [soulRefUrl],
        durationSeconds: POLISH23_CLIP_SECONDS,
        // Polish-23 Commit 3.0.27: batch-scoped seed + Negative
        // keyword list. Same seed on every clip in the batch =
        // kie.ai's documented consistency mechanism.
        seed: polish23Seed,
        negativePrompt: POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS,
        generationJobId: jobId,
      });
      veoSubmitBodies.push({ segmentIndex: i, body: capturedBody });
      console.error(
        `[polish-23-worker Step C] veo-clip-${i} submit body (stderr fallback): ` +
          `${JSON.stringify(capturedBody).slice(0, 500)}`,
      );

      // Polish-23 Commit 3.0.5: persist forensics BEFORE the risky
      // submit. If veo-clip-i throws, the DB write already committed
      // — the operator's SQL query returns the actual prompt +
      // wire body regardless of downstream failure. Own step.run so
      // Inngest caches it and retries don't re-write on function-
      // level retry.
      const composedPromptsSoFar = composedPrompts.slice();
      const veoSubmitBodiesSoFar = veoSubmitBodies.slice();
      await step.run(`persist-clip-${i}-forensics`, async () => {
        const db = getDb();
        const meta = (job.metadata ?? {}) as Record<string, unknown>;
        await db
          .update(schema.generationJobs)
          .set({
            metadata: {
              ...meta,
              character_lock: adSpec.character_lock,
              polish23_segments: adSpec.segments,
              ...metadataExtras,
              higgsfield_soul_ref_url: soulRefUrl,
              polish23_clip_urls: clipUrls,
              polish23_composed_prompts: composedPromptsSoFar,
              polish23_veo_submit_bodies: veoSubmitBodiesSoFar,
              polish23_progress: {
                step: `veo-clip-${i}-forensics`,
                pct: computePolish23SegmentProgress(i, POLISH23_SEGMENT_COUNT),
                at: new Date().toISOString(),
              },
            },
          })
          .where(eq(schema.generationJobs.id, jobId));
      });

      // Polish-23 Commit 3.0.22: outer clip-level auto-retry loop.
      // On any TRUE terminal poll failure (state='fail' with a real
      // errorCode, or a terminal errorKind poll error, or a poll
      // timeout), automatically resubmit the clip as a fresh taskId
      // — kie.ai sometimes gets a specific taskId stuck in a bad
      // state that a resubmit clears.
      //
      // Cap: 2 auto-retries per clip (3 total attempts). Worst-case
      // extra spend per clip = 2 × $0.175 = $0.35; per-generation
      // worst case = 8 × 2 × $0.175 = $2.80 on top of nominal.
      //
      // Between attempts: 15s pause (via step.sleep) so kie.ai has
      // a moment to settle.
      //
      // Note: SUBMIT-side terminal failures (auth / balance / invalid
      // prompt) are NOT auto-retried — those never recover on the
      // same input and would burn cycles for zero benefit. Only
      // POLL-side terminals get the resubmit treatment, which is
      // where kie.ai's flakiness actually surfaces.
      const CLIP_MAX_RETRIES = 2;
      const CLIP_RETRY_BACKOFF_SECONDS = 15;

      let clipUrl: string | null = null;
      let clipRetryChain: Array<{
        segmentIndex: number;
        retryCount: number;
        lastTaskId: string;
        lastErrorMessage: string | null;
        firstFailureAt: string;
        resolvedAt: string | null;
      }> = [];
      let firstFailureAt: string | null = null;
      let lastFailureMessage = 'no failure recorded';

      for (let attempt = 0; attempt <= CLIP_MAX_RETRIES; attempt++) {
        // Persist retry-in-progress forensics + 15s settle pause
        // BEFORE resubmitting (attempts > 0 only).
        if (attempt > 0) {
          const chainSnapshotBeforeRetry = clipRetryChain.slice();
          await step.run(`veo-clip-${i}-retry-persist-r${attempt}`, async () => {
            try {
              const db = getDb();
              const row = await db.query.generationJobs.findFirst({
                where: eq(schema.generationJobs.id, jobId),
                columns: { metadata: true },
              });
              const meta = (row?.metadata ?? {}) as Record<string, unknown>;
              const existing = Array.isArray(meta['polish23_clip_retries'])
                ? (meta['polish23_clip_retries'] as unknown[]).filter(
                    (e) =>
                      !(
                        e &&
                        typeof e === 'object' &&
                        (e as Record<string, unknown>)['segmentIndex'] === i
                      ),
                  )
                : [];
              await db
                .update(schema.generationJobs)
                .set({
                  metadata: {
                    ...meta,
                    polish23_clip_retries: [...existing, ...chainSnapshotBeforeRetry],
                  },
                })
                .where(eq(schema.generationJobs.id, jobId));
            } catch (persistErr) {
              console.error(
                `[polish-23-worker Step C] veo-clip-${i} retry-persist r${attempt} failed: ` +
                  `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
              );
            }
          });
          console.warn(
            `[polish-23-worker Step C] veo-clip-${i} auto-retry r${attempt}/${CLIP_MAX_RETRIES}: ` +
              `prior failure "${lastFailureMessage}". Sleeping ${CLIP_RETRY_BACKOFF_SECONDS}s ` +
              `before fresh submit.`,
          );
          await step.sleep(
            `veo-clip-${i}-retry-wait-r${attempt}`,
            `${CLIP_RETRY_BACKOFF_SECONDS}s`,
          );
        }

        // -------- Submit (per attempt) --------
        let submitResult:
          | { ok: true; taskId: string }
          | { ok: false; terminal: boolean; message: string };
        try {
          submitResult = await step.run(`veo-clip-${i}-submit-r${attempt}`, async () => {
            const keys = await loadDecryptedKeys(userId, ['kie_ai']);
            const submit = await submitKieVeoLite({
              userId,
              apiKey: keys.kie_ai!,
              prompt: truncated.prompt,
              aspectRatio: '9:16',
              imageUrls: [soulRefUrl],
              durationSeconds: POLISH23_CLIP_SECONDS,
              // Polish-23 Commit 3.0.27: batch-scoped seed + Negative
              // keyword list. Same seed on every clip = kie.ai's
              // documented consistency mechanism; the auto-retry
              // loop (Commit 3.0.22) also re-submits with the same
              // seed since polish23Seed is captured from the
              // outer-scope Inngest-cached step result.
              seed: polish23Seed,
              negativePrompt: POLISH23_VEO_NEGATIVE_PROMPT_KEYWORDS,
              generationJobId: jobId,
            });
            if (!submit.ok || !submit.taskId) {
              try {
                const db = getDb();
                const row = await db.query.generationJobs.findFirst({
                  where: eq(schema.generationJobs.id, jobId),
                  columns: { metadata: true },
                });
                const meta = (row?.metadata ?? {}) as Record<string, unknown>;
                await db
                  .update(schema.generationJobs)
                  .set({
                    metadata: {
                      ...meta,
                      polish23_veo_error_response: {
                        segmentIndex: i,
                        attempt,
                        errorMessage: submit.errorMessage,
                        errorKind: submit.errorKind,
                        rawErrorBody: submit.rawErrorBody,
                        at: new Date().toISOString(),
                      },
                    },
                  })
                  .where(eq(schema.generationJobs.id, jobId));
              } catch (persistErr) {
                console.error(
                  `[polish-23-worker Step C] veo-clip-${i} r${attempt} kie-error persist failed: ` +
                    `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                );
              }
              return {
                ok: false as const,
                terminal: submit.errorKind === 'terminal',
                message: submit.errorMessage ?? 'unknown',
              };
            }
            return { ok: true as const, taskId: submit.taskId };
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[polish-23-worker Step C] veo-clip-${i} r${attempt} submit step threw: ${msg}. ` +
              `Ending job as failed.`,
          );
          await markJobFailed(jobId, userId, msg, 0);
          return { jobId, mode, generated: 0 };
        }
        if (!submitResult.ok) {
          // Submit-side terminal failures are NOT auto-retried
          // (auth / balance / invalid prompt won't recover on the
          // same input). Transient submit failures throw regular
          // Error so Inngest's function-level retry (retries: 1)
          // takes one more whole-pipeline shot.
          const cls = submitResult.terminal ? 'terminal' : 'transient';
          const failMsg = `Veo Lite clip ${i} r${attempt} submit ${cls}: ${submitResult.message}`;
          console.error(`[polish-23-worker Step C] ${failMsg}`);
          if (submitResult.terminal) {
            throw new NonRetriableError(failMsg);
          }
          throw new Error(failMsg);
        }
        const taskId = submitResult.taskId;

        // -------- Sleep-poll loop (per attempt) --------
        let terminalFail: { code: string | null; msg: string | null } | null = null;
        let terminalPollError: string | null = null;
        for (let pollAttempt = 0; pollAttempt < VEO_POLL_MAX_ATTEMPTS; pollAttempt++) {
          await step.sleep(
            `veo-clip-${i}-wait-r${attempt}-p${pollAttempt}`,
            `${computeVeoPollBackoffSeconds(pollAttempt)}s`,
          );
          const pollOutcome = await step.run(
            `veo-clip-${i}-poll-r${attempt}-p${pollAttempt}`,
            async () => {
              const keys = await loadDecryptedKeys(userId, ['kie_ai']);
              const poll = await pollKieVeoLite({
                userId,
                apiKey: keys.kie_ai!,
                taskId,
                generationJobId: jobId,
              });
              const snapshot = {
                ok: poll.ok,
                state: poll.state ?? null,
                outputUrl: poll.outputUrl ?? null,
                failCode: poll.failCode ?? null,
                failMsg: poll.failMsg ?? null,
                errorMessage: poll.errorMessage ?? null,
                errorKind: poll.errorKind ?? null,
                costTimeMs: poll.costTimeMs ?? null,
                latencyMs: poll.latencyMs,
                rawResponseBody: poll.rawResponseBody ?? null,
              };
              console.error(
                `[polish-23-worker Step C] veo-clip-${i} r${attempt} poll-${pollAttempt} ` +
                  `ok=${snapshot.ok} state=${snapshot.state ?? 'null'} ` +
                  `errorMessage=${snapshot.errorMessage ?? 'null'} ` +
                  `rawBody=${JSON.stringify(snapshot.rawResponseBody ?? poll.rawErrorBody ?? null).slice(0, 2000)}`,
              );
              try {
                const db = getDb();
                const row = await db.query.generationJobs.findFirst({
                  where: eq(schema.generationJobs.id, jobId),
                  columns: { metadata: true },
                });
                const meta = (row?.metadata ?? {}) as Record<string, unknown>;
                const existing = Array.isArray(meta['polish23_veo_poll_responses'])
                  ? (meta['polish23_veo_poll_responses'] as unknown[])
                  : [];
                await db
                  .update(schema.generationJobs)
                  .set({
                    metadata: {
                      ...meta,
                      polish23_veo_poll_responses: [
                        ...existing,
                        {
                          segmentIndex: i,
                          attempt,
                          pollAttempt,
                          taskId,
                          at: new Date().toISOString(),
                          poll: snapshot,
                        },
                      ],
                    },
                  })
                  .where(eq(schema.generationJobs.id, jobId));
              } catch (persistErr) {
                console.error(
                  `[polish-23-worker Step C] veo-clip-${i} r${attempt} poll-persist failed: ` +
                    `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                );
              }
              return snapshot;
            },
          );

          if (!pollOutcome.ok) {
            if (pollOutcome.errorKind === 'terminal') {
              terminalPollError = pollOutcome.errorMessage ?? 'unknown';
              break;
            }
            console.warn(
              `[polish-23-worker Step C] veo-clip-${i} r${attempt} poll-${pollAttempt} transient ` +
                `(${pollOutcome.errorMessage ?? 'unknown'}); continuing.`,
            );
            continue;
          }
          if (pollOutcome.state === 'fail') {
            terminalFail = {
              code: pollOutcome.failCode,
              msg: pollOutcome.failMsg,
            };
            break;
          }
          if (pollOutcome.state === 'success' && pollOutcome.outputUrl) {
            clipUrl = pollOutcome.outputUrl;
            break;
          }
        }

        // -------- Outcome for this attempt --------
        if (clipUrl !== null) {
          // Success. If any prior attempts failed, mark the chain
          // resolved and persist a final durable snapshot.
          if (clipRetryChain.length > 0) {
            const resolvedAt = new Date().toISOString();
            clipRetryChain = clipRetryChain.map((e) => ({ ...e, resolvedAt }));
            const resolvedSnapshot = clipRetryChain.slice();
            await step.run(`veo-clip-${i}-resolve-persist`, async () => {
              try {
                const db = getDb();
                const row = await db.query.generationJobs.findFirst({
                  where: eq(schema.generationJobs.id, jobId),
                  columns: { metadata: true },
                });
                const meta = (row?.metadata ?? {}) as Record<string, unknown>;
                const existing = Array.isArray(meta['polish23_clip_retries'])
                  ? (meta['polish23_clip_retries'] as unknown[]).filter(
                      (e) =>
                        !(
                          e &&
                          typeof e === 'object' &&
                          (e as Record<string, unknown>)['segmentIndex'] === i
                        ),
                    )
                  : [];
                await db
                  .update(schema.generationJobs)
                  .set({
                    metadata: {
                      ...meta,
                      polish23_clip_retries: [...existing, ...resolvedSnapshot],
                    },
                  })
                  .where(eq(schema.generationJobs.id, jobId));
              } catch (persistErr) {
                console.error(
                  `[polish-23-worker Step C] veo-clip-${i} resolve-persist failed: ` +
                    `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                );
              }
            });
            console.log(
              `[polish-23-worker Step C] veo-clip-${i} recovered on attempt r${attempt} ` +
                `after ${clipRetryChain.length} failure(s). resolvedAt=${resolvedAt}`,
            );
          }
          break;
        }

        // Terminal failure on this attempt — record and decide.
        const failMsg =
          terminalPollError ??
          terminalFail?.msg ??
          terminalFail?.code ??
          `poll timeout after ${VEO_POLL_MAX_ATTEMPTS} attempts (taskId=${taskId})`;
        lastFailureMessage = failMsg;
        if (firstFailureAt === null) firstFailureAt = new Date().toISOString();
        clipRetryChain.push({
          segmentIndex: i,
          retryCount: attempt,
          lastTaskId: taskId,
          lastErrorMessage: failMsg,
          firstFailureAt,
          resolvedAt: null,
        });

        if (attempt === CLIP_MAX_RETRIES) {
          // All attempts exhausted — final NonRetriable.
          const finalChainSnapshot = clipRetryChain.slice();
          await step.run(`veo-clip-${i}-final-fail-persist`, async () => {
            try {
              const db = getDb();
              const row = await db.query.generationJobs.findFirst({
                where: eq(schema.generationJobs.id, jobId),
                columns: { metadata: true },
              });
              const meta = (row?.metadata ?? {}) as Record<string, unknown>;
              const existing = Array.isArray(meta['polish23_clip_retries'])
                ? (meta['polish23_clip_retries'] as unknown[]).filter(
                    (e) =>
                      !(
                        e &&
                        typeof e === 'object' &&
                        (e as Record<string, unknown>)['segmentIndex'] === i
                      ),
                  )
                : [];
              await db
                .update(schema.generationJobs)
                .set({
                  metadata: {
                    ...meta,
                    polish23_clip_retries: [...existing, ...finalChainSnapshot],
                  },
                })
                .where(eq(schema.generationJobs.id, jobId));
            } catch (persistErr) {
              console.error(
                `[polish-23-worker Step C] veo-clip-${i} final-fail persist failed: ` +
                  `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
              );
            }
          });
          const finalMsg =
            `Veo Lite clip ${i}: kie.ai failed ${CLIP_MAX_RETRIES + 1} times ` +
            `(initial + ${CLIP_MAX_RETRIES} auto-retries). Last error: ${failMsg}`;
          console.error(`[polish-23-worker Step C] ${finalMsg}`);
          await markJobFailed(jobId, userId, finalMsg, 0);
          throw new NonRetriableError(finalMsg);
        }
        // else: loop back for next attempt (persist + sleep at top).
      }

      if (clipUrl === null) {
        // Unreachable — the retry loop either sets clipUrl or throws.
        // Kept as a safety net so a control-flow regression can't
        // silently push undefined into clipUrls.
        const msg = `Veo Lite clip ${i}: unreachable state — retry loop exited without success or throw.`;
        console.error(`[polish-23-worker Step C] ${msg}`);
        await markJobFailed(jobId, userId, msg, 0);
        throw new NonRetriableError(msg);
      }
      clipUrls.push(clipUrl);

      // Best-effort progress patch after each clip.
      // Polish-23 Commit 3.0.3: also persist the durable
      // composed-prompt forensics + Commit-3.0.2 metadataExtras
      // (the earlier commit missed this persist site due to a
      // different indentation level, so previous runs dropped
      // metadataExtras between higgsfield-soul persist and the
      // final insert-generated-creative persist).
      const composedPromptsSnapshot = composedPrompts.slice();
      const veoSubmitBodiesSnapshot = veoSubmitBodies.slice();
      await step.run(`persist-clip-${i}-progress`, async () => {
        const db = getDb();
        const meta = (job.metadata ?? {}) as Record<string, unknown>;
        await db
          .update(schema.generationJobs)
          .set({
            metadata: {
              ...meta,
              character_lock: adSpec.character_lock,
              polish23_segments: adSpec.segments,
              ...metadataExtras,
              higgsfield_soul_ref_url: soulRefUrl,
              polish23_clip_urls: clipUrls,
              polish23_composed_prompts: composedPromptsSnapshot,
              polish23_veo_submit_bodies: veoSubmitBodiesSnapshot,
              polish23_progress: {
                step: `veo-clip-${i}`,
                pct: computePolish23SegmentProgress(i, POLISH23_SEGMENT_COUNT),
                at: new Date().toISOString(),
              },
            },
          })
          .where(eq(schema.generationJobs.id, jobId));
      });
    }

    // -------- Step D: Replicate ffmpeg-concat --------
    const compositeUrl = await step.run('replicate-concat', async () => {
      const keys = await loadDecryptedKeys(userId, ['kling']);
      const submit = await submitReplicateConcat({
        userId,
        apiKey: keys.kling!,
        videoUrls: clipUrls,
        generationJobId: jobId,
      });
      if (!submit.ok || !submit.predictionId) {
        throw new Error(`Replicate concat submit failed: ${submit.errorMessage ?? 'unknown'}`);
      }
      const predictionId = submit.predictionId;
      let compositeVideoUrl: string | undefined;
      for (let attempt = 0; attempt < CONCAT_POLL_MAX_ATTEMPTS; attempt++) {
        await sleep(CONCAT_POLL_INTERVAL_SECONDS * 1000);
        const poll = await checkReplicateConcat({
          userId,
          apiKey: keys.kling!,
          predictionId,
          generationJobId: jobId,
        });
        if (poll.status === 'failed') {
          throw new Error(`Replicate concat failed: ${poll.errorMessage ?? 'unknown'}`);
        }
        if (poll.status === 'completed' && poll.videoUrl) {
          compositeVideoUrl = poll.videoUrl;
          break;
        }
      }
      if (!compositeVideoUrl) {
        throw new Error(
          `Replicate concat didn't complete within ` +
            `${CONCAT_POLL_MAX_ATTEMPTS * CONCAT_POLL_INTERVAL_SECONDS}s.`,
        );
      }
      return compositeVideoUrl;
    });

    // -------- Step E: Upload composite + insert generated_creatives --------
    const uploadedUrl = await step.run('upload-composite', async () => {
      const upload = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: compositeUrl,
        filename: 'polish23-composite',
        // Composite target is 100-150 MB (BCH sizing). Under Vercel
        // Pro's 250 MB serverless memory, but compression pass drops
        // to ~30-50 MB for cheaper Meta upload later.
        compress: true,
      });
      return upload.publicUrl;
    });

    await step.run('insert-generated-creative', async () => {
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        fileUrl: uploadedUrl,
        aspectRatio: '9:16',
        status: 'ready_for_review',
        format: 'polish23_higgsfield_veo_lite',
        generationMetadata: {
          polish_version: POLISH_VERSION,
          character_lock_name: adSpec.character_lock.name,
          higgsfield_soul_ref_url: soulRefUrl,
          clip_urls: clipUrls,
          segment_count: adSpec.segments.length,
        },
      });
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(schema.generationJobs)
        .set({
          metadata: {
            ...meta,
            character_lock: adSpec.character_lock,
            polish23_segments: adSpec.segments,
            ...metadataExtras,
            higgsfield_soul_ref_url: soulRefUrl,
            polish23_clip_urls: clipUrls,
            polish23_composed_prompts: composedPrompts,
            polish23_veo_submit_bodies: veoSubmitBodies,
            polish23_composite_url: uploadedUrl,
            polish23_progress: {
              step: 'complete',
              pct: computePolish23Progress('complete'),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // Cost math for markJobCompleted:
    //   Claude ($0.02 approx) + Higgsfield Soul HIGH ($0.23) +
    //   8 × Veo Lite ($0.175) + Replicate concat (~$0.15) = ~$1.82
    const totalCost =
      0.02 +
      WAVESPEED_SOUL_USD_PER_RUN.high +
      adSpec.segments.length * KIE_VEO_LITE_DEFAULT_USD_PER_CLIP +
      0.15;

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: 1,
      actualCostUsd: totalCost,
      provider: 'polish23_higgsfield_veo_lite',
    });

    return { jobId, mode, generated: 1, totalCostUsd: totalCost };
  },
);

/**
 * Polish-19.4.2 pattern reused: pull source ad transcription from
 * metadata.analysis.script_transcription. Returns '' when missing —
 * Claude still runs, just with a placeholder message.
 */
export function extractSourceScript(jobMetadata: Record<string, unknown> | null): string {
  if (!jobMetadata) return '';
  const analysis = jobMetadata['analysis'];
  if (!analysis || typeof analysis !== 'object') return '';
  const t = (analysis as Record<string, unknown>)['script_transcription'];
  return typeof t === 'string' ? t : '';
}

/**
 * Sleep helper (swappable in tests via module import mocking). Kept
 * outside step.run bodies so Inngest step caching isn't triggered by
 * sleeps — sleeps are inside the outer poll loops.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export the AdSpec parser types for test coverage.
export { AdSpecSchema, POLISH23_SEGMENT_COUNT, POLISH23_CLIP_SECONDS };
export type { AdSpec, SegmentSpec };
