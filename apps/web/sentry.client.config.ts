import * as Sentry from '@sentry/nextjs';
import { redactSentryEvent } from '@/lib/sentry-redact';

/**
 * Polish-25.7 Commit 44: extended with the shared credential-redaction
 * `beforeSend` hook. Every event (client-side unhandled error, replay
 * frame, breadcrumb HTTP capture) runs through `redactSentryEvent`
 * before it leaves the browser.
 *
 * DSN is read from NEXT_PUBLIC_SENTRY_DSN so it's baked into the
 * client bundle at build time. Missing DSN → no-op (Sentry stays
 * un-initialized). Environment tag helps triage prod vs preview.
 */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
    beforeSend: redactSentryEvent,
    beforeSendTransaction: redactSentryEvent,
  });
}
