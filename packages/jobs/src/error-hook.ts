import { logError } from '@mbb/db';

/**
 * Polish-25.7 Commit 46: Inngest `onFailure` hook factory.
 *
 * Attach as `onFailure` in `inngest.createFunction`:
 *
 *   inngest.createFunction(
 *     { id: 'meta-ad-launcher', retries: 1, onFailure: logInngestFailure },
 *     { event: 'meta/launch.requested' },
 *     async ({ event, step }) => { ... },
 *   );
 *
 * Fires after Inngest exhausts its retry budget. Extracts the
 * event's userId (all our events include one) plus generationJobId
 * / eventName so the admin errors view can filter by worker
 * surface. Never throws.
 */
export async function logInngestFailure(payload: {
  event: { name: string; data: Record<string, unknown> };
  error: unknown;
  runId?: string;
}): Promise<void> {
  try {
    const data = payload.event.data ?? {};
    const userId = typeof data.userId === 'string' ? data.userId : null;
    await logError({
      userId,
      source: 'worker',
      sourceName: payload.event.name,
      error: payload.error,
      context: {
        eventName: payload.event.name,
        runId: payload.runId,
        // Only include a small allowlist of event.data fields —
        // full payload may include tokens / prompts / other bulky
        // context. logError also runs redaction, but keeping the
        // context narrow reduces row size.
        generationJobId: data.generationJobId ?? null,
        conceptId: data.conceptId ?? null,
      },
    });
  } catch {
    // Never let the failure hook itself throw. logError already
    // swallows write failures but wrap for total safety.
  }
}
