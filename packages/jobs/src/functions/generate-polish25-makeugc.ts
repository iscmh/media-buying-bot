/**
 * Polish-25 Commit 2: MakeUGC pre-cast avatar UGC ad worker.
 *
 * Event: generation/polish25-makeugc.requested
 *
 * Pipeline (each step.run is its own Inngest step for retry + cache):
 *   A. load-job                       — fetch generation_jobs row
 *   B. mark-processing                — status='processing' + progress=5
 *   C. load-concept-source-context    — vision persona from
 *                                       concept.metadata.analysis
 *   D. persist-source-context         — SQL forensic trail
 *   E. claude-script-condense         — rewrite vision analysis into
 *                                       ≤1500-char first-person mono
 *   F. persist-script                 — metadata.polish25_condensed_script
 *   G. makeugc-avatar-match           — hard-filter gender + language
 *                                       via selectMakeugcAvatarForPersona
 *   H. makeugc-submit                 — POST /video/generate (transient
 *                                       auto-retry ×2 with 15s backoff,
 *                                       mirror Polish-23 Commit 3.0.22)
 *   I. makeugc-poll-loop              — sleep-poll pattern from Polish-
 *                                       23 Commit 3.0.20: 60 × 10s = 10m
 *                                       max wait; each poll is own
 *                                       step.run; loud-log raw + interp
 *   J. persist-video-url              — metadata.polish25_video_url +
 *                                       polish25_makeugc_credits_used
 *   K. mark-complete
 *
 * Cost: 1 credit per video @ $0.0495 on API Starter tier.
 *
 * Discipline mirrored from Polish-23:
 *   - NonRetriableError + markJobFailed on all terminal paths (no
 *     zombie jobs — Commit 3.0.29 pattern)
 *   - Persist-before-throw for durable SQL forensics
 *   - Loud-log raw poll status every tick (Commit 3.0.31 pattern)
 *   - Transient auto-retry with recorded retry chain
 *     (metadata.polish25_makeugc_retries[])
 */
import { and, eq, isNull } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  checkMakeugcVideoStatus,
  classifyMakeugcError,
  estimateMakeugcVideoCostUsd,
  isMakeugcTransientError,
  listMakeugcAvatarsCached,
  listMakeugcVoicesCached,
  MakeugcNoMatchingAvatarError,
  MakeugcScriptTooLongError,
  selectMakeugcAvatarForPersona,
  selectMakeugcAvatarForPersonaFromIndex,
  submitMakeugcVideo,
  type MakeugcEnrichedAvatar,
  type MakeugcPersona,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION, Polish23PersonaSchema } from '@mbb/shared';
import { inngest } from '../client';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { resolveMakeugcKey } from '../lib/resolve-makeugc-key';
import {
  POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT,
  checkPolish25CondensedScript,
  composePolish25CondenserUserPrompt,
} from '../lib/polish25-claude-script-condenser-prompt';

console.log(`[jobs.generate-polish25-makeugc] cold start — POLISH_VERSION=${POLISH_VERSION}`);

// Poll cadence: 10s interval × 180 attempts = 30 min max wait.
//
// Polish-25 Commit 6: raised from 60→180 attempts after job 3634604b
// (MakeUGC video cmrt9t0yo000713fkiqltdp2k) proved the marketing
// "2-min processing" claim is aspirational — the same video was
// still at ~50% completion 15+ min in. Real queue-depth latency
// pushes routine renders to 20-30 min. The prior 10-min cap turned
// otherwise-successful renders into false timeout-fails.
const MAKEUGC_POLL_INTERVAL_SECONDS = 10;
export const MAKEUGC_POLL_MAX_ATTEMPTS = 180;
// Log a heartbeat every Nth poll to Vercel Runtime Logs so a stuck
// render is visible without waiting for the final timeout message.
const MAKEUGC_POLL_HEARTBEAT_EVERY = 30;

// Submit-side auto-retry on transient errors (mirror Polish-23
// Commit 3.0.22 clip-level retry). Max 2 retries + 15s backoff between.
const MAKEUGC_SUBMIT_MAX_RETRIES = 2;
const MAKEUGC_SUBMIT_RETRY_BACKOFF_SECONDS = 15;

function nowIso(): string {
  return new Date().toISOString();
}

async function patchMetadata(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const row = await db.query.generationJobs.findFirst({
    where: eq(schema.generationJobs.id, jobId),
    columns: { metadata: true },
  });
  const existing = (row?.metadata ?? {}) as Record<string, unknown>;
  await db
    .update(schema.generationJobs)
    .set({ metadata: { ...existing, ...patch } })
    .where(eq(schema.generationJobs.id, jobId));
}

export const generatePolish25Makeugc = inngest.createFunction(
  {
    id: 'generate-polish25-makeugc',
    name: 'Polish-25: MakeUGC pre-cast avatar UGC ad',
    // Function-level retry ONE — internal auto-retry lives inside
    // submit + poll steps.
    retries: 1,
  },
  { event: 'generation/polish25-makeugc.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    // -------- Step A: load job --------
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

    // -------- Step B: mark processing --------
    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
      await patchMetadata(jobId, {
        polish25_progress: { step: 'mark-processing', pct: 5, at: nowIso() },
      });
    });

    // -------- Step C: load concept + vision persona --------
    const conceptId = job.conceptIds?.[0];
    if (!conceptId) {
      const msg = 'Polish-25 requires a concept with vision-analyzed persona metadata.';
      console.error(`[polish-25-worker] ${msg}`);
      await markJobFailed(jobId, userId, msg, 0);
      throw new NonRetriableError(msg);
    }

    const sourceLookup = await step.run('load-concept-source-context', async () => {
      const db = getDb();
      const concept = await db.query.concepts.findFirst({
        where: eq(schema.concepts.id, conceptId),
        columns: { metadata: true, ugcOriginalScript: true },
      });
      const conceptMeta = (concept?.metadata as Record<string, unknown> | null) ?? null;
      const conceptAnalysis = conceptMeta?.['analysis'] ?? null;
      // Polish-25 Commit 3: persona-only extraction. Unlike Polish-23
      // (which needs setting_details + emotional_arc + hook_structure
      // + niche_category for Higgsfield Soul prompt construction),
      // Polish-25 only needs `persona` for the MakeUGC avatar match.
      // The condenser eats the raw JSON blob verbatim, so we do NOT
      // require the full Polish23VisionAdditions bundle — a partial
      // hydration (persona present, siblings missing/malformed) is
      // fine here.
      if (conceptAnalysis && typeof conceptAnalysis === 'object') {
        const analysisObj = conceptAnalysis as Record<string, unknown>;
        const fieldsPresent = {
          persona: analysisObj['persona'] != null,
          setting_details: analysisObj['setting_details'] != null,
          emotional_arc: analysisObj['emotional_arc'] != null,
          hook_structure: analysisObj['hook_structure'] != null,
          niche_category: analysisObj['niche_category'] != null,
        };
        console.log(
          `[polish-25-worker] source-context field presence for concept ${conceptId}: ` +
            JSON.stringify(fieldsPresent),
        );
        const personaParse = Polish23PersonaSchema.safeParse(analysisObj['persona']);
        if (personaParse.success) {
          return {
            source: 'vision_analysis_persona' as const,
            visionAnalysisJson: JSON.stringify(conceptAnalysis, null, 2),
            persona: personaParse.data,
            fieldsPresent,
            personaParseError: null,
          };
        }
        return {
          source: 'none' as const,
          visionAnalysisJson: null,
          persona: null,
          fieldsPresent,
          personaParseError: personaParse.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        };
      }
      return {
        source: 'none' as const,
        visionAnalysisJson: null,
        persona: null,
        fieldsPresent: null,
        personaParseError: 'concept.metadata.analysis is missing or not an object',
      };
    });

    if (sourceLookup.source !== 'vision_analysis_persona' || !sourceLookup.persona) {
      const msg =
        `Polish-25 requires concept ${conceptId} to have concepts.metadata.analysis.persona ` +
        `populated + parseable (gender enum + age_range + ethnicity enum + look + voice_tone). ` +
        `Field presence: ${JSON.stringify(sourceLookup.fieldsPresent)}. ` +
        `Persona parse error: ${sourceLookup.personaParseError ?? 'n/a'}. ` +
        `Run analyze-concept first.`;
      console.error(`[polish-25-worker] ${msg}`);
      await markJobFailed(jobId, userId, msg, 0);
      throw new NonRetriableError(msg);
    }

    // -------- Step D: persist source context --------
    await step.run('persist-source-context', async () => {
      await patchMetadata(jobId, {
        polish25_source_context: {
          conceptId,
          source: sourceLookup.source,
          personaGender: sourceLookup.persona?.gender,
          personaAgeRange: sourceLookup.persona?.age_range,
          personaEthnicity: sourceLookup.persona?.ethnicity,
          textChars: sourceLookup.visionAnalysisJson?.length ?? 0,
          // Polish-25 Commit 3: durable diagnostic for which
          // Polish-23 vision-analysis sibling fields are present.
          // Non-persona siblings are optional for Polish-25 but
          // useful when debugging why analyze-concept output shape
          // varies across concepts.
          fieldsPresent: sourceLookup.fieldsPresent,
          at: nowIso(),
        },
        polish25_progress: { step: 'source-context', pct: 15, at: nowIso() },
      });
    });

    // -------- Step E: Claude script condenser --------
    const condensedScript = await step.run('claude-script-condense', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          const msg = `Polish-25 script condenser requires Claude BYOK key. ${err.message}`;
          console.error(`[polish-25-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
        throw err;
      }
      const userMessage = composePolish25CondenserUserPrompt(
        sourceLookup.visionAnalysisJson ?? '(no analysis available)',
      );
      const r = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt: POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT,
        userMessage,
        maxTokens: 2048,
        generationJobId: jobId,
      });
      const rawText = (r.text ?? '').trim();
      // Persist BEFORE any throw — durable SQL forensics for
      // condenser failures (mirror Polish-23 Commit 3.0.5 pattern).
      //
      // Polish-25 Commit 4: also persist the FULL rawText to
      // polish25_condensed_script itself (not just the excerpt on
      // condenser_response) so operator can inspect the exact
      // script that failed validation via one SQL column, not two.
      // Step F re-writes this same field on the happy path; the
      // pre-validation write is only observable when the job later
      // fails at check-time.
      await patchMetadata(jobId, {
        polish25_condensed_script: rawText,
        polish25_condensed_script_chars: rawText.length,
        polish25_claude_condenser_response: {
          ok: r.ok,
          chars: rawText.length,
          rawTextExcerpt: rawText.slice(0, 2000),
          errorMessage: r.errorMessage,
          at: nowIso(),
        },
      });
      if (!r.ok) {
        const msg = `Polish-25 Claude condenser call failed: ${r.errorMessage ?? 'unknown'}`;
        console.error(`[polish-25-worker] ${msg}`);
        await markJobFailed(jobId, userId, msg, 0);
        throw new NonRetriableError(msg);
      }
      const check = checkPolish25CondensedScript(rawText);
      if (!check.ok) {
        const msg =
          `Polish-25 condensed-script validation failed [${check.reason}]: ${check.detail}. ` +
          `Excerpt (first 400 chars): ${JSON.stringify(rawText.slice(0, 400))}`;
        console.error(`[polish-25-worker] ${msg}`);
        await patchMetadata(jobId, {
          polish25_script_validation_failure: {
            reason: check.reason,
            detail: check.detail,
            at: nowIso(),
          },
        });
        await markJobFailed(jobId, userId, msg, 0);
        throw new NonRetriableError(msg);
      }
      return rawText;
    });

    // -------- Step F: persist condensed script --------
    await step.run('persist-script', async () => {
      await patchMetadata(jobId, {
        polish25_condensed_script: condensedScript,
        polish25_condensed_script_chars: condensedScript.length,
        polish25_progress: { step: 'script-condensed', pct: 30, at: nowIso() },
      });
    });

    // -------- Step G: MakeUGC avatar match --------
    const persona: MakeugcPersona = {
      gender: sourceLookup.persona.gender === 'male' ? 'male' : 'female',
      age_range: sourceLookup.persona.age_range,
      ethnicity: sourceLookup.persona.ethnicity,
      look: sourceLookup.persona.look,
      voice_tone: sourceLookup.persona.voice_tone,
      language: 'English',
    };
    interface MakeugcMatchStepReturn {
      avatarId: string;
      avatarName: string;
      voiceId: string;
      voiceName: string;
    }
    const match = await step.run(
      'makeugc-avatar-match',
      async (): Promise<MakeugcMatchStepReturn> => {
        // Polish-25.2 Commit 11: MakeUGC is platform-managed. The
        // resolver prefers MAKEUGC_MANAGED_KEY env, falls back to
        // the user's BYOK row for dev + legacy contexts.
        let makeugcKey: string;
        try {
          const resolved = await resolveMakeugcKey({ userId });
          makeugcKey = resolved.apiKey;
        } catch (err) {
          if (err instanceof MissingProviderKeyError) {
            const msg =
              'Polish-25 Instant UGC platform key is not configured. ' +
              'Set MAKEUGC_MANAGED_KEY env or ask an operator to connect one.';
            console.error(`[polish-25-worker] ${msg}`);
            await markJobFailed(jobId, userId, msg, 0);
            throw new NonRetriableError(msg);
          }
          throw err;
        }
        const genderFilter = persona.gender === 'male' ? 'Male' : 'Female';

        // Voices always come from the live cached list — the enriched
        // index only enriches AVATARS. The voice pool is per-user
        // and small enough to not need pre-analysis.
        const voicesResult = await listMakeugcVoicesCached({
          userId,
          apiKey: makeugcKey,
          gender: genderFilter,
          language: 'English',
          generationJobId: jobId,
        });
        if (!voicesResult.ok) {
          const msg = `MakeUGC voice list failed: ${voicesResult.errorMessage ?? 'unknown'}`;
          console.error(`[polish-25-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }

        // Polish-25 Commit 7: try the enriched index first.
        // - Query makeugc_avatar_index for undeleted rows in this gender.
        // - If the index has ≥1 row → run selectMakeugcAvatarForPersonaFromIndex
        //   (hard-filter gender + age±1, soft-score ethnicity/hair/facial-hair/wardrobe).
        // - If empty → fall back to Commit 1's gender-only matcher over
        //   listMakeugcAvatarsCached. Loud-log the fallback so operators
        //   see when the nightly cron hasn't populated yet or when the
        //   index was wiped.
        const db = getDb();
        const enrichedRows = await db.query.makeugcAvatarIndex.findMany({
          where: and(
            eq(schema.makeugcAvatarIndex.makeugcGender, genderFilter),
            isNull(schema.makeugcAvatarIndex.deletedAt),
          ),
          columns: {
            avatarId: true,
            avatarName: true,
            makeugcGender: true,
            ageBucket: true,
            ethnicity: true,
            hairColor: true,
            hairStyle: true,
            facialHair: true,
            wardrobeStyle: true,
            wardrobeSummary: true,
            backgroundSetting: true,
          },
        });

        // ---------- Enriched-index path ----------
        if (enrichedRows.length > 0) {
          const enriched: MakeugcEnrichedAvatar[] = enrichedRows.map((r) => ({
            avatarId: r.avatarId,
            avatarName: r.avatarName,
            makeugcGender: r.makeugcGender,
            ageBucket: r.ageBucket,
            ethnicity: r.ethnicity,
            hairColor: r.hairColor,
            hairStyle: r.hairStyle,
            facialHair: r.facialHair,
            wardrobeStyle: r.wardrobeStyle,
            wardrobeSummary: r.wardrobeSummary,
            backgroundSetting: r.backgroundSetting,
          }));
          try {
            const matched = selectMakeugcAvatarForPersonaFromIndex(
              persona,
              enriched,
              voicesResult.voices,
            );
            await patchMetadata(jobId, {
              polish25_avatar_match: {
                matchStrategy: matched.matchLog.matchStrategy,
                candidatesConsidered: matched.matchLog.candidatesConsidered,
                hardFilters: matched.matchLog.hardFilters,
                scoredCandidates: matched.matchLog.scoredCandidates,
                winnerAvatarId: matched.matchLog.winnerAvatarId,
                winnerVoiceId: matched.matchLog.winnerVoiceId,
                winnerVoiceTtsEngineId: matched.voice.voiceId,
                winnerScore: matched.matchLog.winnerScore,
                winnerAgeBucket: matched.avatar.ageBucket,
                winnerEthnicity: matched.avatar.ethnicity,
                winnerHairColor: matched.avatar.hairColor,
              },
              polish25_progress: { step: 'avatar-matched', pct: 45, at: nowIso() },
            });
            return {
              avatarId: matched.avatar.avatarId,
              avatarName: matched.avatar.avatarName,
              voiceId: matched.voice.id,
              voiceName: matched.voice.name,
            };
          } catch (err) {
            if (err instanceof MakeugcNoMatchingAvatarError) {
              const msg =
                `Polish-25 enriched avatar match failed: ${err.message}. ` +
                `Add matching MakeUGC actors or lift persona filters.`;
              console.error(`[polish-25-worker] ${msg}`);
              await patchMetadata(jobId, {
                polish25_avatar_match_failure: {
                  persona,
                  candidatesConsidered: err.candidatesConsidered,
                  hardFiltersApplied: err.hardFiltersApplied,
                  matchStrategy: 'enriched-index',
                  at: nowIso(),
                },
              });
              await markJobFailed(jobId, userId, msg, 0);
              throw new NonRetriableError(msg);
            }
            throw err;
          }
        }

        // ---------- Empty-index fallback (Commit 1 behavior) ----------
        console.warn(
          `[polish-25-worker] enriched index empty; falling back to gender-only match. ` +
            `Trigger 'makeugc/avatar-index.refresh.requested' to populate.`,
        );
        const avatarsResult = await listMakeugcAvatarsCached({
          userId,
          apiKey: makeugcKey,
          gender: genderFilter,
          generationJobId: jobId,
        });
        if (!avatarsResult.ok) {
          const msg = `MakeUGC avatar list failed: ${avatarsResult.errorMessage ?? 'unknown'}`;
          console.error(`[polish-25-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
        try {
          const matched = selectMakeugcAvatarForPersona(
            persona,
            avatarsResult.avatars,
            voicesResult.voices,
          );
          await patchMetadata(jobId, {
            polish25_avatar_match: {
              matchStrategy: 'gender-only-fallback',
              candidatesConsidered: matched.matchLog.candidatesConsidered,
              hardFilters: matched.matchLog.hardFilters,
              scoredCandidates: matched.matchLog.scoredCandidates,
              winnerAvatarId: matched.matchLog.winnerAvatarId,
              winnerVoiceId: matched.matchLog.winnerVoiceId,
              winnerVoiceTtsEngineId: matched.voice.voiceId,
              winnerScore: matched.matchLog.winnerScore,
            },
            polish25_progress: { step: 'avatar-matched', pct: 45, at: nowIso() },
          });
          return {
            avatarId: matched.avatar.id,
            avatarName: matched.avatar.name,
            voiceId: matched.voice.id,
            voiceName: matched.voice.name,
          };
        } catch (err) {
          if (err instanceof MakeugcNoMatchingAvatarError) {
            const msg =
              `Polish-25 avatar match failed: ${err.message}. ` +
              `Add matching MakeUGC actors or lift persona filters.`;
            console.error(`[polish-25-worker] ${msg}`);
            await patchMetadata(jobId, {
              polish25_avatar_match_failure: {
                persona,
                candidatesConsidered: err.candidatesConsidered,
                hardFiltersApplied: err.hardFiltersApplied,
                matchStrategy: 'gender-only-fallback',
                at: nowIso(),
              },
            });
            await markJobFailed(jobId, userId, msg, 0);
            throw new NonRetriableError(msg);
          }
          throw err;
        }
      },
    );

    // -------- Step H: submit (auto-retry ×2 on transient) --------
    const retryChain: Array<{
      attempt: number;
      errorMessage: string | null;
      errorClass: 'transient' | 'terminal';
      at: string;
    }> = [];

    const videoId = await step.run('makeugc-submit-with-retry', async () => {
      // Polish-25.2 Commit 11: resolver picks up MAKEUGC_MANAGED_KEY
      // env; falls back to BYOK for dev + legacy contexts.
      const { apiKey: makeugcKey } = await resolveMakeugcKey({ userId });
      for (let attempt = 0; attempt <= MAKEUGC_SUBMIT_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          console.warn(
            `[polish-25-worker] makeugc submit auto-retry r${attempt}/${MAKEUGC_SUBMIT_MAX_RETRIES}: ` +
              `sleeping ${MAKEUGC_SUBMIT_RETRY_BACKOFF_SECONDS}s.`,
          );
          await new Promise((r) => setTimeout(r, MAKEUGC_SUBMIT_RETRY_BACKOFF_SECONDS * 1000));
        }
        let submit;
        try {
          submit = await submitMakeugcVideo({
            userId,
            apiKey: makeugcKey,
            avatarId: match.avatarId,
            voiceId: match.voiceId,
            voiceScript: condensedScript,
            videoName: `polish25-job-${jobId}`,
            generationJobId: jobId,
          });
        } catch (err) {
          if (err instanceof MakeugcScriptTooLongError) {
            const msg = `Polish-25 submit rejected: ${err.message}`;
            console.error(`[polish-25-worker] ${msg}`);
            await markJobFailed(jobId, userId, msg, 0);
            throw new NonRetriableError(msg);
          }
          throw err;
        }
        if (submit.ok && submit.videoId) {
          if (retryChain.length > 0) {
            await patchMetadata(jobId, { polish25_makeugc_retries: retryChain.slice() });
          }
          return submit.videoId;
        }
        const errorMessage = submit.errorMessage ?? 'unknown';
        const category =
          submit.errorCategory ?? classifyMakeugcError(submit.httpStatus, errorMessage);
        const transient =
          isMakeugcTransientError(errorMessage) ||
          category === 'server' ||
          category === 'rate_limit';
        retryChain.push({
          attempt,
          errorMessage,
          errorClass: transient ? 'transient' : 'terminal',
          at: nowIso(),
        });
        await patchMetadata(jobId, { polish25_makeugc_retries: retryChain.slice() });
        if (!transient) {
          const msg = `Polish-25 submit terminal (${category}): ${errorMessage}`;
          console.error(`[polish-25-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
        if (attempt === MAKEUGC_SUBMIT_MAX_RETRIES) {
          const msg =
            `Polish-25 submit failed ${MAKEUGC_SUBMIT_MAX_RETRIES + 1} times ` +
            `(initial + ${MAKEUGC_SUBMIT_MAX_RETRIES} auto-retries). Last error: ${errorMessage}. ` +
            `MakeUGC likely unavailable — try again in a few minutes.`;
          console.error(`[polish-25-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
      }
      throw new NonRetriableError('Polish-25 submit loop exited without videoId (unreachable)');
    });

    await step.run('persist-submit', async () => {
      await patchMetadata(jobId, {
        polish25_makeugc_video_id: videoId,
        polish25_progress: { step: 'submitted', pct: 55, at: nowIso() },
      });
    });

    // -------- Step I: poll loop (sleep-poll pattern) --------
    let videoUrl: string | null = null;
    let terminalReason: string | null = null;
    let terminalErrorCategory: string | null = null;
    for (let pollAttempt = 0; pollAttempt < MAKEUGC_POLL_MAX_ATTEMPTS; pollAttempt++) {
      await step.sleep(`polish25-poll-wait-${pollAttempt}`, `${MAKEUGC_POLL_INTERVAL_SECONDS}s`);
      const pollOutcome = await step.run(`polish25-poll-${pollAttempt}`, async () => {
        // Polish-25.2 Commit 11: env-then-BYOK resolver.
        const { apiKey: makeugcKey } = await resolveMakeugcKey({ userId });
        const poll = await checkMakeugcVideoStatus({
          userId,
          apiKey: makeugcKey,
          videoId,
          generationJobId: jobId,
        });
        const snapshot = {
          ok: poll.ok,
          status: poll.status,
          url: poll.url ?? null,
          reason: poll.reason ?? null,
          errorMessage: poll.errorMessage ?? null,
          errorCategory: poll.errorCategory ?? null,
          latencyMs: poll.latencyMs,
          httpStatus: poll.httpStatus ?? null,
        };
        // Append poll snapshot to metadata (read-modify-write append-safe,
        // mirror Polish-23 Commit 3.0.9 pattern).
        try {
          const db = getDb();
          const row = await db.query.generationJobs.findFirst({
            where: eq(schema.generationJobs.id, jobId),
            columns: { metadata: true },
          });
          const meta = (row?.metadata ?? {}) as Record<string, unknown>;
          const existing = Array.isArray(meta['polish25_makeugc_poll_responses'])
            ? (meta['polish25_makeugc_poll_responses'] as unknown[])
            : [];
          await db
            .update(schema.generationJobs)
            .set({
              metadata: {
                ...meta,
                polish25_makeugc_poll_responses: [
                  ...existing,
                  { pollAttempt, at: nowIso(), poll: snapshot },
                ],
              },
            })
            .where(eq(schema.generationJobs.id, jobId));
        } catch (persistErr) {
          console.error(
            `[polish-25-worker] poll-response persist failed: ` +
              `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          );
        }
        return snapshot;
      });

      if (!pollOutcome.ok) {
        const msg = pollOutcome.errorMessage ?? 'unknown';
        if (isMakeugcTransientError(msg)) {
          console.warn(`[polish-25-worker] poll-${pollAttempt} transient (${msg}); continuing.`);
          continue;
        }
        terminalReason = msg;
        terminalErrorCategory = pollOutcome.errorCategory ?? 'unknown';
        break;
      }
      if (pollOutcome.status === 'failed') {
        terminalReason = pollOutcome.reason ?? 'MakeUGC reported failed (no reason)';
        break;
      }
      if (pollOutcome.status === 'completed' && pollOutcome.url) {
        videoUrl = pollOutcome.url;
        break;
      }
      // Otherwise (processing / queued) — next sleep bracket.
      // Polish-25 Commit 6: heartbeat every 30 polls (~5 min) so a
      // slow-but-still-live render is visible in Vercel Runtime Logs
      // without waiting for the ~30-min timeout message.
      if ((pollAttempt + 1) % MAKEUGC_POLL_HEARTBEAT_EVERY === 0) {
        console.log(
          `[polish-25-worker] Still polling video ${videoId}, attempt ${pollAttempt + 1}/${MAKEUGC_POLL_MAX_ATTEMPTS}`,
        );
      }
    }

    if (terminalReason !== null) {
      const msg = `Polish-25 poll terminal ${terminalErrorCategory ?? '(unknown)'}: ${terminalReason}`;
      console.error(`[polish-25-worker] ${msg}`);
      await markJobFailed(jobId, userId, msg, 0);
      throw new NonRetriableError(msg);
    }
    if (videoUrl === null) {
      const msg =
        `Polish-25 poll timeout after ${MAKEUGC_POLL_MAX_ATTEMPTS} attempts ` +
        `(~${(MAKEUGC_POLL_MAX_ATTEMPTS * MAKEUGC_POLL_INTERVAL_SECONDS) / 60} min). ` +
        `videoId=${videoId}. MakeUGC likely stuck — real processing can exceed 30 min, retry may work.`;
      console.error(`[polish-25-worker] ${msg}`);
      await markJobFailed(jobId, userId, msg, 0);
      throw new NonRetriableError(msg);
    }

    // -------- Step J: persist video URL + credits --------
    const costUsd = estimateMakeugcVideoCostUsd('starter');
    await step.run('persist-video-url', async () => {
      await patchMetadata(jobId, {
        polish25_video_url: videoUrl,
        polish25_makeugc_credits_used: {
          creditsUsed: 1,
          costUsd,
          tier: 'starter',
          at: nowIso(),
        },
        polish25_progress: { step: 'video-ready', pct: 95, at: nowIso() },
      });
      // Insert a generated_creatives row so the review UI surfaces the
      // rendered ad exactly like other pipelines.
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        fileUrl: videoUrl,
        aspectRatio: '9:16',
        status: 'ready_for_review',
        format: 'polish25_makeugc',
        generationMetadata: {
          polish_version: POLISH_VERSION,
          avatarId: match.avatarId,
          avatarName: match.avatarName,
          voiceId: match.voiceId,
          voiceName: match.voiceName,
          scriptChars: condensedScript.length,
          costUsd,
        },
      });
    });

    // -------- Step K: mark complete --------
    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: 1,
      actualCostUsd: costUsd,
      provider: 'polish25_makeugc',
    });

    return { jobId, mode, generated: 1, totalCostUsd: costUsd, videoUrl };
  },
);
