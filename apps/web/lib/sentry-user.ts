import 'server-only';
import * as Sentry from '@sentry/nextjs';

/**
 * Polish-25.7 Commit 44: attach the authed user to the current
 * Sentry scope so every event captured during this request carries
 * user_id / email / is_admin.
 *
 * Next.js 14 App Router isolates async context per request via
 * async_hooks, so calling Sentry.setUser inside a server component
 * or server action attaches the identity only to events captured
 * within THIS request. Concurrent requests on the same process do
 * not cross-pollinate.
 *
 * No-op if SENTRY_DSN isn't set (dev without Sentry credentials).
 */
export function setSentryUser(input: { userId: string; email: string; isAdmin?: boolean }): void {
  if (!process.env.SENTRY_DSN && !process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  Sentry.setUser({
    id: input.userId,
    email: input.email,
    // Sentry allows arbitrary extra fields — is_admin is useful triage
    // signal (an admin's error report is usually the operator).
    is_admin: !!input.isAdmin,
  });
}
