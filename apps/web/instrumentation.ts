import * as Sentry from '@sentry/nextjs';
import { redactSentryEvent } from '@/lib/sentry-redact';

/**
 * Polish-25.7 Commit 44: server + edge Sentry init with credential
 * redaction. The Next.js `register()` hook runs once per runtime
 * (nodejs / edge) when the server boots — SSR requests, route
 * handlers, server actions, and (importantly) the Inngest handler
 * mounted at /api/inngest all inherit this instrumentation.
 *
 * DSN is read from SENTRY_DSN (server-only). Missing DSN → no-op so
 * local dev without a DSN doesn't spam init warnings.
 *
 * onRequestError = Sentry.captureRequestError wires unhandled server
 * component / route handler errors into Sentry automatically. Next
 * 15's `instrumentation-client.ts` convention is unnecessary here —
 * sentry.client.config.ts still runs on Next 14.
 */
export async function register() {
  const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  const common = {
    dsn,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
    beforeSend: redactSentryEvent,
    beforeSendTransaction: redactSentryEvent,
  } as const;

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init(common);
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init(common);
  }
}

export const onRequestError = Sentry.captureRequestError;
