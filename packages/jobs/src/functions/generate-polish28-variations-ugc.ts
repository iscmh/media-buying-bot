/**
 * Polish-28.3.0 Commit 85: BYOK Instant UGC — VARIATIONS mode.
 *
 * Sibling of generate-polish28-clone-ugc.ts. Where clone mode
 * produces ONE video that replicates the source ad's specific
 * actor, variations mode produces N videos each with a DIFFERENT
 * persona pitching the SAME offer. This is the Meta A/B-testing
 * pattern operators actually want most of the time — launch 5
 * distinct spokespeople, measure which demographic converts, scale
 * the winner.
 *
 * Pipeline per job (single Claude batch + N parallel HeyGen chains):
 *
 *   A. load-job                  fetch generation_jobs + concept
 *   B. mark-processing           update status + progress
 *   C. preflight-byok            3-BYOK check: Claude, Gemini, HeyGen
 *                                (NO Replicate — no source-frame extract)
 *   D. load-source-context       persona + vision-analysis JSON from concept
 *   E. generate-variations       Claude batch call → N {persona, script} pairs
 *   F. fetch-heygen-voices       one GET /v2/voices call, shared across variants
 *   G. render-variants           Promise.all fan-out over N entries:
 *                                  - Nano Banana character (text-only prompt)
 *                                  - Match voice for this variant's persona
 *                                  - Upload character to HeyGen
 *                                  - Submit av4/generate (script + voice_id)
 *                                  - Poll until completed
 *                                  - Download + upload final video
 *                                  - Persist creative row
 *   H. mark-completed            aggregate cost + mark job done
 *
 * BYOK requirement: 3 keys (Claude, Gemini, HeyGen). Drops Replicate
 * from the clone-mode 4-BYOK gate — variations don't extract from the
 * source ad's video (characters generated fresh from persona text).
 *
 * Output: N x 9:16 vertical videos. Locked per Polish-28 spec.
 *
 * Parallelism note: fan-out uses Promise.all(step.run(...)) so each
 * variant's HeyGen chain runs concurrently. Inngest v3 supports this
 * via step.run identity-keyed by the step name (variantIndex-suffixed
 * here). For very large N (say 50+) HeyGen rate limits or Inngest's
 * per-function-invocation timeout could bite; not a concern at
 * typical N=1-10. Future Polish-28.4 could fan out via separate event
 * dispatch to give per-variant retry isolation.
 */
import { eq } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import { callClaude, fetchHeygenVoices, matchHeygenVoiceForPersona } from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { loadDecryptedKeys, MissingProviderKeyError } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import {
  assertNoUndefinedForPostgres,
  assertScalarDefinedForPostgres,
  guardedStepRun,
  rethrowWithUndefinedContext,
} from '../lib/assert-no-undefined-for-postgres';
import { safeInngestStepReturn } from '../lib/strip-undefined';
import {
  POLISH28_VARIATIONS_SYSTEM_PROMPT,
  composePolish28VariationsUserPrompt,
  parsePolish28VariationsResponse,
} from '../lib/polish28-variations-prompt';
import { wrapWithPsywarCorpus } from '../lib/polish28-psywar-corpus';

console.log(
  `[jobs.generate-polish28-variations-ugc] cold start — POLISH_VERSION=${POLISH_VERSION}`,
);

/** Hard cap per single-job invocation. Higher N should batch via
 *  multiple jobs; sub-worker already parallelizes per-variant. */
const MAX_VARIANTS_PER_JOB = 10;

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
  const cleaned = assertNoUndefinedForPostgres(
    { ...existing, ...patch },
    'polish28-variations:patchMetadata',
  );
  await db
    .update(schema.generationJobs)
    .set({ metadata: cleaned })
    .where(eq(schema.generationJobs.id, jobId));
}

export const generatePolish28VariationsUgc = inngest.createFunction(
  {
    id: 'generate-polish28-variations-ugc',
    name: 'Polish-28: BYOK Instant UGC — variations (N distinct spokespeople)',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish28-variations-ugc.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data as {
      jobId: string;
      userId: string;
      mode: 'mock' | 'live';
    };
    const startedAt = Date.now();

    try {
      const jobUserId = assertScalarDefinedForPostgres(userId, 'userId', 'polish28-var:entry');

      // ---------- Step A: load job ----------
      const job = await guardedStepRun(step, 'load-job', async () => {
        const db = getDb();
        const row = await db.query.generationJobs.findFirst({
          where: eq(schema.generationJobs.id, jobId),
          columns: { variantCount: true, metadata: true, conceptIds: true },
        });
        return safeInngestStepReturn(row ?? null);
      });
      if (!job) {
        await markJobFailed(jobId, jobUserId, 'Polish-28-variations: job row not found', 0);
        return { jobId, mode, generated: 0 };
      }
      const conceptId = job.conceptIds?.[0];
      if (!conceptId) {
        const msg =
          'Polish-28 variations requires a concept with vision-analyzed persona metadata.';
        await markJobFailed(jobId, jobUserId, msg, 0);
        throw new NonRetriableError(msg);
      }
      const requestedVariantCount = Math.max(
        1,
        Math.min(MAX_VARIANTS_PER_JOB, job.variantCount ?? 1),
      );

      // ---------- Step B: mark processing ----------
      await guardedStepRun(step, 'mark-processing', async () => {
        const db = getDb();
        await db
          .update(schema.generationJobs)
          .set({ status: 'processing' })
          .where(eq(schema.generationJobs.id, jobId));
        await patchMetadata(jobId, {
          polish28_progress: { step: 'mark-processing', pct: 3, at: nowIso() },
          polish28_mode: 'variations',
          polish28_variant_count_requested: requestedVariantCount,
        });
        return safeInngestStepReturn({ ok: true });
      });

      // ---------- Step C: preflight BYOK (3 keys) ----------
      const keys = await guardedStepRun(step, 'preflight-byok', async () => {
        try {
          const loaded = await loadDecryptedKeys(jobUserId, ['claude', 'gemini', 'heygen']);
          if (!loaded.claude) throw new MissingProviderKeyError('claude');
          if (!loaded.gemini) throw new MissingProviderKeyError('gemini');
          if (!loaded.heygen) throw new MissingProviderKeyError('heygen');
          return safeInngestStepReturn({
            claude: loaded.claude,
            gemini: loaded.gemini,
            heygen: loaded.heygen,
          });
        } catch (err) {
          if (err instanceof MissingProviderKeyError) {
            throw new NonRetriableError(
              `Polish-28 variations requires 3 BYOK keys (Claude + Gemini + HeyGen). ` +
                `Missing: ${err.message}. Connect at /settings/connections.`,
            );
          }
          throw err;
        }
      });

      // ---------- Step D: load concept + vision-analysis JSON ----------
      const source = await guardedStepRun(step, 'load-source-context', async () => {
        const db = getDb();
        const concept = await db.query.concepts.findFirst({
          where: eq(schema.concepts.id, conceptId),
          columns: { metadata: true, ugcOriginalScript: true },
        });
        if (!concept) {
          throw new NonRetriableError(`Polish-28-variations: concept ${conceptId} not found.`);
        }
        const conceptMeta = (concept.metadata ?? null) as Record<string, unknown> | null;
        const analysis = (conceptMeta?.['analysis'] ?? null) as Record<string, unknown> | null;
        const visionAnalysisJson = analysis ? JSON.stringify(analysis, null, 2) : null;
        return safeInngestStepReturn({
          visionAnalysisJson,
          ugcOriginalScript: concept.ugcOriginalScript ?? '',
        });
      });

      // ---------- Step E: generate N persona+script pairs via Claude ----------
      const variations = await guardedStepRun(step, 'generate-variations', async () => {
        const rawInput =
          source.visionAnalysisJson ??
          (source.ugcOriginalScript && source.ugcOriginalScript.trim().length >= 20
            ? source.ugcOriginalScript
            : null);
        if (!rawInput) {
          throw new NonRetriableError(
            `Polish-28-variations has no usable input: concept ${conceptId} has neither ` +
              `metadata.analysis (Gemini vision output) nor ugcOriginalScript >=20 chars. ` +
              `Re-run analyze-concept on this concept before submitting.`,
          );
        }
        const userPrompt = composePolish28VariationsUserPrompt(rawInput, requestedVariantCount);
        const r = await callClaude({
          userId: jobUserId,
          apiKey: keys.claude!,
          // Polish-28.3.6 Commit 91: prepend the full Psywar-branded
          // PSYWAR corpus (sections 28 + 29, ~416KB / ~100K tokens)
          // to the system prompt VERBATIM per operator directive
          // (no summarization, no folding). cacheSystemPrompt:true
          // marks the whole system block as cacheable — first call
          // pays full input cost, subsequent calls within the ~5min
          // cache TTL pay ~10% for the cached portion. Corpus goes
          // BEFORE the instruction prompt so both get cached together.
          systemPrompt: wrapWithPsywarCorpus(POLISH28_VARIATIONS_SYSTEM_PROMPT),
          cacheSystemPrompt: true,
          userMessage: userPrompt,
          maxTokens: 8000,
          generationJobId: jobId,
        });
        if (!r.ok || !r.text || r.text.trim().length === 0) {
          throw new NonRetriableError(
            `Polish-28-variations Claude batch call failed: ${r.errorMessage ?? 'unknown'}`,
          );
        }
        const parsed = parsePolish28VariationsResponse(r.text);
        if (parsed.entries.length === 0) {
          throw new NonRetriableError(
            `Polish-28-variations Claude returned 0 valid entries. ` +
              `Errors: ${parsed.errors.slice(0, 5).join(' | ')}. ` +
              `Raw excerpt: ${JSON.stringify(r.text.slice(0, 500))}`,
          );
        }
        await patchMetadata(jobId, {
          polish28_progress: { step: 'generate-variations', pct: 15, at: nowIso() },
          polish28_variations_returned: parsed.entries.length,
          polish28_variations_parse_errors: parsed.errors,
        });
        return safeInngestStepReturn({ entries: parsed.entries });
      });

      // ---------- Step F: fetch HeyGen voice roster (shared) ----------
      const voices = await guardedStepRun(step, 'fetch-heygen-voices', async () => {
        const fetched = await fetchHeygenVoices({
          userId: jobUserId,
          apiKey: keys.heygen!,
          generationJobId: jobId,
        });
        if (!fetched.ok || fetched.voices.length === 0) {
          throw new NonRetriableError(
            `Polish-28-variations HeyGen voice-list fetch failed: ${fetched.errorMessage ?? 'no voices returned'}`,
          );
        }
        return safeInngestStepReturn({ voices: fetched.voices });
      });

      // ---------- Step G: dispatch per-variant events + await completions ----------
      // Polish-30.0.17 Commit 189: dropped the Commit-188 sequential
      // for-loop for proper per-variant Inngest event dispatch. Each
      // variant runs as its own Inngest function invocation
      // (`generate-polish28-variant`) → true parallelism, no step.sleep
      // checkpoint collisions, independent retry isolation per variant,
      // unblocker for bulk use (10+ variations per job).
      //
      // Parent waits on N `polish28-variant.completed` events via
      // Promise.all of step.waitForEvent. waitForEvent is server-side
      // registered on the Inngest side (different primitive from
      // step.run / step.sleep) and parallelizes cleanly.
      //
      // Voice matching stays on the parent — we already have the full
      // roster in `voices.voices` from Step F; match once per variant
      // and pass the picked voice through the event payload. Avoids
      // N × fetch-voices calls on the sub-workers.
      //
      // Keys do NOT cross the event boundary — plaintext secrets must
      // not persist in Inngest step state. Sub-workers re-load keys
      // from the DB via loadDecryptedKeys using the userId in the event.
      const variantDispatchPlan = variations.entries.map((entry, index) => {
        const personaSentence =
          `${entry.persona.age_range} ${entry.persona.gender} ${entry.persona.ethnicity}. ` +
          entry.persona.look;
        const matchedVoice = matchHeygenVoiceForPersona(voices.voices, personaSentence);
        return {
          index,
          entry,
          matchedVoice: {
            voice_id: matchedVoice.voice_id,
            name: matchedVoice.name,
            gender: matchedVoice.gender,
          },
        };
      });

      // Fire all N sub-events in parallel.
      await guardedStepRun(step, 'dispatch-variants', async () => {
        await Promise.all(
          variantDispatchPlan.map((plan) =>
            step.sendEvent(`dispatch-variant-${plan.index}`, {
              name: 'generation/polish28-variant.requested',
              data: {
                jobId,
                userId: jobUserId,
                variantIndex: plan.index,
                entry: plan.entry,
                matchedVoice: plan.matchedVoice,
              },
            }),
          ),
        );
        await patchMetadata(jobId, {
          polish28_progress: {
            step: 'dispatched-variants',
            pct: 40,
            at: nowIso(),
            variantCount: variantDispatchPlan.length,
          },
        });
        return safeInngestStepReturn({ dispatched: variantDispatchPlan.length });
      });

      // Wait for N completion events in parallel.
      const completionResults = await Promise.all(
        variantDispatchPlan.map((plan) =>
          step
            .waitForEvent(`wait-variant-${plan.index}`, {
              event: 'generation/polish28-variant.completed',
              timeout: '45m', // HeyGen Avatar IV worst case ~22 min; 2x buffer
              if: `async.data.jobId == "${jobId}" && async.data.variantIndex == ${plan.index}`,
            })
            .then((evt) => {
              if (!evt || !evt.data) {
                return {
                  ok: false as const,
                  index: plan.index,
                  error: `variant ${plan.index} did not complete within 45 min (likely stuck in HeyGen)`,
                };
              }
              const data = evt.data as {
                jobId: string;
                variantIndex: number;
                ok: boolean;
                costUsd?: number;
                videoUrl?: string;
                error?: string;
              };
              return data.ok
                ? {
                    ok: true as const,
                    index: plan.index,
                    costUsd: data.costUsd ?? 0,
                  }
                : {
                    ok: false as const,
                    index: plan.index,
                    error: data.error ?? 'unknown error from sub-worker',
                  };
            }),
        ),
      );

      const variantResults: Array<
        { ok: true; index: number; costUsd: number } | { ok: false; index: number; error: string }
      > = completionResults;

      const succeeded = variantResults.filter(
        (r): r is { ok: true; index: number; costUsd: number } => r.ok,
      );
      const failed = variantResults.filter(
        (r): r is { ok: false; index: number; error: string } => !r.ok,
      );

      // ---------- Step H: mark completed ----------
      const totalCost = succeeded.reduce((sum, r) => sum + r.costUsd, 0);
      if (succeeded.length === 0) {
        const firstErr = failed[0]?.error ?? 'all variants failed with no error';
        await markJobFailed(
          jobId,
          jobUserId,
          `Polish-28-variations: all ${variantResults.length} variants failed. First: ${firstErr}`,
          totalCost,
        );
        throw new NonRetriableError(
          `Polish-28-variations: 0/${variantResults.length} variants succeeded. First error: ${firstErr}`,
        );
      }
      await markJobCompleted({
        jobId,
        userId: jobUserId,
        mode,
        startedAt,
        variantCount: succeeded.length,
        actualCostUsd: totalCost,
        provider: 'clone_ugc',
        path: 'ugc',
      });
      await patchMetadata(jobId, {
        polish28_progress: { step: 'completed', pct: 100, at: nowIso() },
        polish28_variants_succeeded: succeeded.length,
        polish28_variants_failed: failed.length,
        polish28_variants_failures: failed.map((f) => ({
          index: f.index,
          error: f.error.slice(0, 500),
        })),
      });
      return {
        jobId,
        mode,
        generated: succeeded.length,
        failed: failed.length,
        totalCostUsd: totalCost,
      };
    } catch (err) {
      rethrowWithUndefinedContext(err, 'generatePolish28VariationsUgc');
    }
  },
);
