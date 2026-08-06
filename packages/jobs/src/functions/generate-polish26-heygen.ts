/**
 * Polish-26 Commit 61: HeyGen v3 pre-cast avatar UGC ad worker.
 *
 * Event: generation/polish26-heygen.requested
 *
 * Direct mirror of generate-polish25-makeugc.ts. Same Inngest step
 * shape (A load → B mark-processing → C source-context → D persist
 * → E claude-condense → F persist-script → G avatar-match → H
 * submit-with-retry → I poll-loop → J persist-video-url → K mark-
 * complete) so a future operator toggling between backends reads
 * one control flow, not two.
 *
 * Differences from Polish-25:
 *   - Reads/writes the polish26_ metadata prefix (never collides
 *     with a job that also ran Polish-25).
 *   - Uses heygen_avatar_index (populated by refresh-heygen-avatar-
 *     index cron) for persona matching, not makeugc_avatar_index.
 *   - Poll cap is 60 attempts × 10s = 10 min (HeyGen renders in
 *     2-5 min typical; MakeUGC needed 60 min because the queue
 *     depth was pathological). If HeyGen renders start timing out
 *     we raise this, not silently paper over.
 *   - Cost stamped via estimateHeygenVideoCostUsd({engine:'avatar_v',
 *     seconds: <actual video length>}) — HeyGen is per-second so
 *     the actual cost varies with output length.
 *   - Hotlinks the HeyGen CDN URL into generated_creatives.fileUrl
 *     for the initial landing (matching the MakeUGC pattern). The
 *     Commit-62 follow-up will download + mirror to Supabase
 *     Storage since HeyGen CDN URLs may expire in ~7 days per the
 *     API-docs research finding.
 *
 * Legacy Polish-24 HeyGen worker (generate-ugc-variants.ts on
 * generation/ugc.requested) is unchanged and continues to serve
 * BYOK HeyGen users on the v1/v2 endpoints.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import {
  callClaude,
  checkHeygenVideoStatus,
  classifyHeygenError,
  estimateHeygenVideoCostUsd,
  HeygenV3NoMatchingAvatarError,
  HeygenScriptTooLongError,
  isHeygenV3TransientError,
  listHeygenAvatars,
  listHeygenVoices,
  selectHeygenAvatarForPersonaFromIndex,
  submitHeygenVideo,
  type HeygenEnrichedAvatar,
  // The legacy Polish-24 client also exports a `HeygenPersona` type
  // with a slightly different shape — we want the v3 one, which the
  // barrel re-exports under the `HeygenV3Persona` alias.
  type HeygenV3Persona as HeygenPersona,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION, Polish23PersonaSchema } from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { resolveHeygenManagedKey } from '../lib/resolve-heygen-managed-key';
import {
  POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT,
  checkPolish25CondensedScript,
  composePolish25CondenserUserPrompt,
} from '../lib/polish25-claude-script-condenser-prompt';

console.log(`[jobs.generate-polish26-heygen] cold start — POLISH_VERSION=${POLISH_VERSION}`);

// HeyGen v3 renders in 2-5 min typical (community reports). Cap
// well above that so a queue spike doesn't false-timeout. 60 × 10s
// = 10 min ceiling; raise this if production data shows genuine
// slower renders (don't silently paper over — a stuck poll should
// surface).
const HEYGEN_POLL_INTERVAL_SECONDS = 10;
export const HEYGEN_POLL_MAX_ATTEMPTS = 60;
const HEYGEN_POLL_HEARTBEAT_EVERY = 12; // every ~2 min

const HEYGEN_SUBMIT_MAX_RETRIES = 2;
const HEYGEN_SUBMIT_RETRY_BACKOFF_SECONDS = 15;

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

export const generatePolish26Heygen = inngest.createFunction(
  {
    id: 'generate-polish26-heygen',
    name: 'Polish-26: HeyGen v3 pre-cast avatar UGC ad',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish26-heygen.requested' },
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
        polish26_progress: { step: 'mark-processing', pct: 5, at: nowIso() },
      });
    });

    // -------- Step C: load concept + vision persona --------
    const conceptId = job.conceptIds?.[0];
    if (!conceptId) {
      const msg = 'Polish-26 requires a concept with vision-analyzed persona metadata.';
      console.error(`[polish-26-worker] ${msg}`);
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
          `[polish-26-worker] source-context field presence for concept ${conceptId}: ` +
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
        `Polish-26 requires concept ${conceptId} to have concepts.metadata.analysis.persona ` +
        `populated + parseable. Field presence: ${JSON.stringify(sourceLookup.fieldsPresent)}. ` +
        `Persona parse error: ${sourceLookup.personaParseError ?? 'n/a'}. Run analyze-concept first.`;
      console.error(`[polish-26-worker] ${msg}`);
      await markJobFailed(jobId, userId, msg, 0);
      throw new NonRetriableError(msg);
    }

    // -------- Step D: persist source context --------
    await step.run('persist-source-context', async () => {
      await patchMetadata(jobId, {
        polish26_source_context: {
          conceptId,
          source: sourceLookup.source,
          personaGender: sourceLookup.persona?.gender,
          personaAgeRange: sourceLookup.persona?.age_range,
          personaEthnicity: sourceLookup.persona?.ethnicity,
          textChars: sourceLookup.visionAnalysisJson?.length ?? 0,
          fieldsPresent: sourceLookup.fieldsPresent,
          at: nowIso(),
        },
        polish26_progress: { step: 'source-context', pct: 15, at: nowIso() },
      });
    });

    // -------- Step E: Claude script condenser (reuses Polish-25 prompt) --------
    const condensedScript = await step.run('claude-script-condense', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          const msg = `Polish-26 script condenser requires Claude BYOK key. ${err.message}`;
          console.error(`[polish-26-worker] ${msg}`);
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
      await patchMetadata(jobId, {
        polish26_condensed_script: rawText,
        polish26_condensed_script_chars: rawText.length,
        polish26_claude_condenser_response: {
          ok: r.ok,
          chars: rawText.length,
          rawTextExcerpt: rawText.slice(0, 2000),
          errorMessage: r.errorMessage,
          at: nowIso(),
        },
      });
      if (!r.ok) {
        const msg = `Polish-26 Claude condenser call failed: ${r.errorMessage ?? 'unknown'}`;
        console.error(`[polish-26-worker] ${msg}`);
        await markJobFailed(jobId, userId, msg, 0);
        throw new NonRetriableError(msg);
      }
      const check = checkPolish25CondensedScript(rawText);
      if (!check.ok) {
        const msg =
          `Polish-26 condensed-script validation failed [${check.reason}]: ${check.detail}. ` +
          `Excerpt: ${JSON.stringify(rawText.slice(0, 400))}`;
        console.error(`[polish-26-worker] ${msg}`);
        await patchMetadata(jobId, {
          polish26_script_validation_failure: {
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
        polish26_condensed_script: condensedScript,
        polish26_condensed_script_chars: condensedScript.length,
        polish26_progress: { step: 'script-condensed', pct: 30, at: nowIso() },
      });
    });

    // -------- Step G: HeyGen avatar match --------
    const persona: HeygenPersona = {
      gender: sourceLookup.persona.gender === 'male' ? 'male' : 'female',
      age_range: sourceLookup.persona.age_range,
      ...(sourceLookup.persona.ethnicity ? { ethnicity: sourceLookup.persona.ethnicity } : {}),
      ...(sourceLookup.persona.look ? { look: sourceLookup.persona.look } : {}),
      ...(sourceLookup.persona.voice_tone ? { voice_tone: sourceLookup.persona.voice_tone } : {}),
      language: 'English',
    };

    interface HeygenMatchStepReturn {
      avatarId: string;
      avatarName: string;
      voiceId: string;
      voiceName: string;
      matchStrategy: 'enriched-index' | 'live-listing-gender-only';
    }

    const match = await step.run(
      'heygen-avatar-match',
      async (): Promise<HeygenMatchStepReturn> => {
        let heygenKey: string;
        try {
          const resolved = await resolveHeygenManagedKey({ userId });
          heygenKey = resolved.apiKey;
        } catch (err) {
          if (err instanceof MissingProviderKeyError) {
            const msg =
              'Polish-26 Instant UGC platform key is not configured. ' +
              'Set HEYGEN_MANAGED_KEY env or ask an operator to connect one.';
            console.error(`[polish-26-worker] ${msg}`);
            await markJobFailed(jobId, userId, msg, 0);
            throw new NonRetriableError(msg);
          }
          throw err;
        }

        const voicesResult = await listHeygenVoices({
          userId,
          apiKey: heygenKey,
          generationJobId: jobId,
        });
        if (!voicesResult.ok) {
          const msg = `HeyGen voice list failed: ${voicesResult.errorMessage ?? 'unknown'}`;
          console.error(`[polish-26-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }

        const db = getDb();
        const enrichedRows = await db.query.heygenAvatarIndex.findMany({
          where: and(
            eq(schema.heygenAvatarIndex.heygenGender, persona.gender),
            isNull(schema.heygenAvatarIndex.deletedAt),
          ),
          columns: {
            avatarId: true,
            avatarName: true,
            thumbnailUrl: true,
            heygenGender: true,
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
          const enriched: HeygenEnrichedAvatar[] = enrichedRows.map((r) => ({
            avatarId: r.avatarId,
            avatarName: r.avatarName,
            thumbnailUrl: r.thumbnailUrl,
            heygenGender: r.heygenGender,
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
            const matched = selectHeygenAvatarForPersonaFromIndex(
              persona,
              enriched,
              voicesResult.voices,
            );
            await patchMetadata(jobId, {
              polish26_avatar_match: {
                matchStrategy: 'enriched-index',
                candidatesConsidered: matched.matchLog.candidatesConsidered,
                hardFilters: matched.matchLog.hardFilters,
                scoredCandidates: matched.matchLog.scoredCandidates,
                winnerAvatarId: matched.matchLog.winnerAvatarId,
                winnerVoiceId: matched.matchLog.winnerVoiceId,
                winnerScore: matched.matchLog.winnerScore,
                winnerAgeBucket: matched.avatar.ageBucket,
                winnerEthnicity: matched.avatar.ethnicity,
                winnerHairColor: matched.avatar.hairColor,
              },
              polish26_progress: { step: 'avatar-matched', pct: 45, at: nowIso() },
            });
            return {
              avatarId: matched.avatar.avatarId,
              avatarName: matched.avatar.avatarName,
              voiceId: matched.voice.voice_id,
              voiceName: matched.voice.name,
              matchStrategy: 'enriched-index',
            };
          } catch (err) {
            if (err instanceof HeygenV3NoMatchingAvatarError) {
              const msg =
                `Polish-26 enriched avatar match failed: ${err.message}. ` +
                `Refresh heygen_avatar_index or lift persona filters.`;
              console.error(`[polish-26-worker] ${msg}`);
              await patchMetadata(jobId, {
                polish26_avatar_match_failure: {
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

        // ---------- Empty-index fallback ----------
        console.warn(
          `[polish-26-worker] heygen_avatar_index empty; falling back to gender-only ` +
            `live-listing match. Trigger 'heygen/avatar-index.refresh.requested' to populate.`,
        );
        const avatarsResult = await listHeygenAvatars({
          userId,
          apiKey: heygenKey,
          generationJobId: jobId,
        });
        if (!avatarsResult.ok) {
          const msg = `HeyGen avatar list failed: ${avatarsResult.errorMessage ?? 'unknown'}`;
          console.error(`[polish-26-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
        // Simple gender-only filter + first-hit pick. Loud-log the pick.
        const genderMatched = avatarsResult.avatars.filter(
          (a) => a.gender?.toLowerCase() === persona.gender,
        );
        const pickedAvatar = genderMatched[0] ?? avatarsResult.avatars[0];
        if (!pickedAvatar) {
          const msg = `HeyGen live listing returned no avatars for gender=${persona.gender}.`;
          console.error(`[polish-26-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
        const pickedVoice = voicesResult.voices[0];
        if (!pickedVoice) {
          const msg = 'HeyGen voice list is empty; cannot proceed with a video.';
          console.error(`[polish-26-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
        await patchMetadata(jobId, {
          polish26_avatar_match: {
            matchStrategy: 'live-listing-gender-only',
            candidatesConsidered: avatarsResult.avatars.length,
            hardFilters: [`gender=${persona.gender}`],
            winnerAvatarId: pickedAvatar.avatar_id,
            winnerVoiceId: pickedVoice.voice_id,
            winnerScore: 0,
          },
          polish26_progress: { step: 'avatar-matched', pct: 45, at: nowIso() },
        });
        return {
          avatarId: pickedAvatar.avatar_id,
          avatarName: pickedAvatar.avatar_name,
          voiceId: pickedVoice.voice_id,
          voiceName: pickedVoice.name,
          matchStrategy: 'live-listing-gender-only',
        };
      },
    );

    // -------- Step H: submit (auto-retry ×2 on transient) --------
    const retryChain: Array<{
      attempt: number;
      errorMessage: string | null;
      errorClass: 'transient' | 'terminal';
      at: string;
    }> = [];

    const videoId = await step.run('heygen-submit-with-retry', async () => {
      const { apiKey: heygenKey } = await resolveHeygenManagedKey({ userId });
      for (let attempt = 0; attempt <= HEYGEN_SUBMIT_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          console.warn(
            `[polish-26-worker] heygen submit auto-retry r${attempt}/${HEYGEN_SUBMIT_MAX_RETRIES}: ` +
              `sleeping ${HEYGEN_SUBMIT_RETRY_BACKOFF_SECONDS}s.`,
          );
          await new Promise((r) => setTimeout(r, HEYGEN_SUBMIT_RETRY_BACKOFF_SECONDS * 1000));
        }
        let submit;
        try {
          submit = await submitHeygenVideo({
            userId,
            apiKey: heygenKey,
            avatarId: match.avatarId,
            voiceId: match.voiceId,
            script: condensedScript,
            aspectRatio: '9:16',
            videoName: `polish26-job-${jobId}`,
            test: mode === 'mock',
            callbackId: jobId,
            generationJobId: jobId,
          });
        } catch (err) {
          if (err instanceof HeygenScriptTooLongError) {
            const msg = `Polish-26 submit rejected: ${err.message}`;
            console.error(`[polish-26-worker] ${msg}`);
            await markJobFailed(jobId, userId, msg, 0);
            throw new NonRetriableError(msg);
          }
          throw err;
        }
        if (submit.ok && submit.videoId) {
          if (retryChain.length > 0) {
            await patchMetadata(jobId, { polish26_heygen_retries: retryChain.slice() });
          }
          return submit.videoId;
        }
        const errorMessage = submit.errorMessage ?? 'unknown';
        const category =
          submit.errorCategory ?? classifyHeygenError(submit.httpStatus, errorMessage);
        const transient =
          isHeygenV3TransientError(errorMessage) ||
          category === 'server' ||
          category === 'rate_limit';
        retryChain.push({
          attempt,
          errorMessage,
          errorClass: transient ? 'transient' : 'terminal',
          at: nowIso(),
        });
        await patchMetadata(jobId, { polish26_heygen_retries: retryChain.slice() });
        if (!transient) {
          const msg = `Polish-26 submit terminal (${category}): ${errorMessage}`;
          console.error(`[polish-26-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
        if (attempt === HEYGEN_SUBMIT_MAX_RETRIES) {
          const msg =
            `Polish-26 submit failed ${HEYGEN_SUBMIT_MAX_RETRIES + 1} times ` +
            `(initial + ${HEYGEN_SUBMIT_MAX_RETRIES} auto-retries). Last error: ${errorMessage}. ` +
            `HeyGen likely unavailable — try again in a few minutes.`;
          console.error(`[polish-26-worker] ${msg}`);
          await markJobFailed(jobId, userId, msg, 0);
          throw new NonRetriableError(msg);
        }
      }
      throw new NonRetriableError('Polish-26 submit loop exited without videoId (unreachable)');
    });

    await step.run('persist-submit', async () => {
      await patchMetadata(jobId, {
        polish26_heygen_video_id: videoId,
        polish26_progress: { step: 'submitted', pct: 55, at: nowIso() },
      });
    });

    // -------- Step I: poll loop --------
    let videoUrl: string | null = null;
    let terminalReason: string | null = null;
    let terminalErrorCategory: string | null = null;
    let actualDurationSeconds: number | null = null;
    for (let pollAttempt = 0; pollAttempt < HEYGEN_POLL_MAX_ATTEMPTS; pollAttempt++) {
      await step.sleep(`polish26-poll-wait-${pollAttempt}`, `${HEYGEN_POLL_INTERVAL_SECONDS}s`);
      const pollOutcome = await step.run(`polish26-poll-${pollAttempt}`, async () => {
        const { apiKey: heygenKey } = await resolveHeygenManagedKey({ userId });
        const poll = await checkHeygenVideoStatus({
          userId,
          apiKey: heygenKey,
          videoId,
          generationJobId: jobId,
        });
        const snapshot = {
          ok: poll.ok,
          status: poll.status,
          url: poll.url ?? null,
          durationSeconds: poll.durationSeconds ?? null,
          reason: poll.reason ?? null,
          errorMessage: poll.errorMessage ?? null,
          errorCategory: poll.errorCategory ?? null,
          latencyMs: poll.latencyMs,
          httpStatus: poll.httpStatus ?? null,
        };
        try {
          const db = getDb();
          const row = await db.query.generationJobs.findFirst({
            where: eq(schema.generationJobs.id, jobId),
            columns: { metadata: true },
          });
          const meta = (row?.metadata ?? {}) as Record<string, unknown>;
          const existing = Array.isArray(meta['polish26_heygen_poll_responses'])
            ? (meta['polish26_heygen_poll_responses'] as unknown[])
            : [];
          await db
            .update(schema.generationJobs)
            .set({
              metadata: {
                ...meta,
                polish26_heygen_poll_responses: [
                  ...existing,
                  { pollAttempt, at: nowIso(), poll: snapshot },
                ],
              },
            })
            .where(eq(schema.generationJobs.id, jobId));
        } catch (persistErr) {
          console.error(
            `[polish-26-worker] poll-response persist failed: ` +
              `${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          );
        }
        return snapshot;
      });

      if (!pollOutcome.ok) {
        const msg = pollOutcome.errorMessage ?? 'unknown';
        if (isHeygenV3TransientError(msg)) {
          console.warn(`[polish-26-worker] poll-${pollAttempt} transient (${msg}); continuing.`);
          continue;
        }
        terminalReason = msg;
        terminalErrorCategory = pollOutcome.errorCategory ?? 'unknown';
        break;
      }
      if (pollOutcome.status === 'failed') {
        terminalReason = pollOutcome.reason ?? 'HeyGen reported failed (no reason)';
        break;
      }
      if (pollOutcome.status === 'completed' && pollOutcome.url) {
        videoUrl = pollOutcome.url;
        actualDurationSeconds = pollOutcome.durationSeconds ?? null;
        break;
      }
      if ((pollAttempt + 1) % HEYGEN_POLL_HEARTBEAT_EVERY === 0) {
        console.log(
          `[polish-26-worker] Still polling video ${videoId}, ` +
            `attempt ${pollAttempt + 1}/${HEYGEN_POLL_MAX_ATTEMPTS}`,
        );
      }
    }

    if (terminalReason !== null) {
      const msg = `Polish-26 poll terminal ${terminalErrorCategory ?? '(unknown)'}: ${terminalReason}`;
      console.error(`[polish-26-worker] ${msg}`);
      await markJobFailed(jobId, userId, msg, 0);
      throw new NonRetriableError(msg);
    }
    if (videoUrl === null) {
      const timeoutMin = (HEYGEN_POLL_MAX_ATTEMPTS * HEYGEN_POLL_INTERVAL_SECONDS) / 60;
      const msg =
        `Polish-26 poll timeout after ${HEYGEN_POLL_MAX_ATTEMPTS} attempts (~${timeoutMin} min). ` +
        `videoId=${videoId}. HeyGen may still finish the render — check the /admin/errors log ` +
        `or the HeyGen dashboard.`;
      console.error(`[polish-26-worker] ${msg}`);
      await patchMetadata(jobId, {
        polish26_processing_timeout: true,
        polish26_processing_timeout_at: nowIso(),
        polish26_stuck_video_id: videoId,
      });
      await markJobFailed(jobId, userId, msg, 0);
      throw new NonRetriableError(msg);
    }

    // -------- Step J: persist video URL + cost --------
    // HeyGen bills per-second on Avatar V. If the poll returned a
    // real duration, use it; otherwise fall back to the 30s default
    // (typical UGC hook length) which matches our estimator.
    const billableSeconds = actualDurationSeconds ?? 30;
    const costUsd = estimateHeygenVideoCostUsd({
      engine: 'avatar_v',
      seconds: billableSeconds,
    });

    await step.run('persist-video-url', async () => {
      await patchMetadata(jobId, {
        polish26_video_url: videoUrl,
        polish26_heygen_cost: {
          engine: 'avatar_v',
          seconds: billableSeconds,
          usdPerSecond: 0.05,
          costUsd,
          at: nowIso(),
        },
        polish26_progress: { step: 'video-ready', pct: 95, at: nowIso() },
      });
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        fileUrl: videoUrl,
        aspectRatio: '9:16',
        status: 'ready_for_review',
        format: 'polish26_heygen',
        generationMetadata: {
          polish_version: POLISH_VERSION,
          avatarId: match.avatarId,
          avatarName: match.avatarName,
          voiceId: match.voiceId,
          voiceName: match.voiceName,
          matchStrategy: match.matchStrategy,
          scriptChars: condensedScript.length,
          durationSeconds: billableSeconds,
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
      provider: 'polish26_heygen',
    });

    return { jobId, mode, generated: 1, totalCostUsd: costUsd, videoUrl };
  },
);
