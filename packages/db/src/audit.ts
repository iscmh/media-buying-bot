import { getDb } from './client';
import { auditLogs } from './schema/logs';

/**
 * Record an application audit event. Callable from anywhere — web, bot, jobs.
 *
 * `userId` is optional for platform-level events (e.g. global emergency stop).
 * `eventData` is free-form JSON; keep it small and never include secrets.
 */
export async function logAuditEvent(input: {
  userId?: string | null;
  eventType: string;
  eventData?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await db.insert(auditLogs).values({
    userId: input.userId ?? null,
    eventType: input.eventType,
    eventData: input.eventData ?? {},
  });
}
