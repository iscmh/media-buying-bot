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
}

export type CreativeFormat = 'avatar_talking_head';

export interface FailoverDecision {
  /** null when no fallback is possible (no alternate providers connected). */
  fallback: CreativeFormat | null;
  /** Short human-readable tag, persisted to generation_jobs.metadata.failover_log. */
  reason: string;
}

/**
 * Polish-20 Commit 4: cinematic_voiceover format retired with the
 * ElevenLabs deletion. Avatar-talking-head failure now has no
 * fallback route; the worker marks failed + notifies the operator.
 * Kept as a no-op decision helper so the generate-ugc-variants
 * caller doesn't need a code-shape change.
 */
export function pickFailoverFormat(
  currentFormat: string,
  _ready: FailoverReadyState,
): FailoverDecision {
  return {
    fallback: null,
    reason: `no_fallback_available_after_polish_20:${currentFormat}`,
  };
}

/**
 * Format the Inngest event name a failover decision dispatches to.
 * Polish-20 Commit 4: only ugc.requested survives.
 */
export function failoverEventName(_fallback: CreativeFormat): 'generation/ugc.requested' {
  return 'generation/ugc.requested';
}

/**
 * User-facing Telegram copy when every provider failed. Caller passes
 * the jobId so operators can click straight into the failed job.
 */
export function buildAllProvidersFailedMessage(jobId: string): string {
  return (
    'All connected providers failed to generate variants for your last job.\n' +
    `Job: /runs/${jobId}\n\n` +
    'Open the job page for the per-variant error log and connect a backup provider on /connections/ai-provider.'
  );
}
