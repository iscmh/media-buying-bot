/**
 * Polish-4: pure failover decision tree.
 *
 * When a variant-generation worker completes with zero successful
 * variants, it asks this helper "given the format we just failed on
 * and the providers the user has connected, which alternate format
 * can we retry on?" The worker then re-dispatches the matching event
 * (generation/cinematic.requested ↔ generation/ugc.requested) once.
 *
 * Cycle prevention: callers stamp metadata.failover_attempted=true
 * before dispatching, and check it on entry — if set, no further
 * failover (just mark failed + send Telegram).
 */

export interface FailoverReadyState {
  /** User has an active heygen connection. */
  heygen: boolean;
  /** User has BOTH kling + elevenlabs (cinematic_voiceover needs both). */
  klingAndElevenLabs: boolean;
}

export type CreativeFormat = 'avatar_talking_head' | 'cinematic_voiceover';

export interface FailoverDecision {
  /** null when no fallback is possible (no alternate providers connected). */
  fallback: CreativeFormat | null;
  /** Short human-readable tag, persisted to generation_jobs.metadata.failover_log. */
  reason: string;
}

export function pickFailoverFormat(
  currentFormat: string,
  ready: FailoverReadyState,
): FailoverDecision {
  if (currentFormat === 'cinematic_voiceover') {
    if (ready.heygen) {
      return {
        fallback: 'avatar_talking_head',
        reason: 'kling_failed_falling_back_to_heygen',
      };
    }
    return { fallback: null, reason: 'kling_failed_no_heygen_fallback' };
  }
  if (currentFormat === 'avatar_talking_head') {
    if (ready.klingAndElevenLabs) {
      return {
        fallback: 'cinematic_voiceover',
        reason: 'heygen_failed_falling_back_to_kling',
      };
    }
    return { fallback: null, reason: 'heygen_failed_no_cinematic_fallback' };
  }
  return { fallback: null, reason: `unknown_format:${currentFormat}` };
}

/**
 * Format the Inngest event name a failover decision dispatches to.
 * Centralized so the mapping doesn't drift across workers.
 */
export function failoverEventName(
  fallback: CreativeFormat,
): 'generation/cinematic.requested' | 'generation/ugc.requested' {
  return fallback === 'cinematic_voiceover'
    ? 'generation/cinematic.requested'
    : 'generation/ugc.requested';
}

/**
 * User-facing Telegram copy when every provider failed. Caller passes
 * the jobId so operators can click straight into the failed job.
 */
export function buildAllProvidersFailedMessage(jobId: string): string {
  return (
    'All connected providers failed to generate variants for your last job.\n' +
    `Job: /jobs/${jobId}\n\n` +
    'Open the job page for the per-variant error log and connect a backup provider on /connections/ai-provider.'
  );
}
