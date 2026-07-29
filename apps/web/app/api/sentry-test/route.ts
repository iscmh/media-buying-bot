import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Polish-25.7 Commit 44 verification helper — DELETE AFTER VERIFYING.
 *
 * Purpose: prove three things about the Sentry pipeline in one round-trip:
 *   1. Server-side unhandled errors reach Sentry (via
 *      instrumentation.ts's onRequestError = Sentry.captureRequestError).
 *   2. Explicit Sentry.captureException + captureMessage calls reach
 *      Sentry (via server-side init in instrumentation.ts).
 *   3. The shared beforeSend hook in lib/sentry-redact.ts scrubs
 *      credentials from the payload before the event leaves the box.
 *
 * How to use:
 *   1. Ensure NEXT_PUBLIC_SENTRY_DSN + SENTRY_DSN are set in Vercel.
 *   2. Redeploy so the env vars propagate to the running function.
 *   3. curl -i "https://<host>/api/sentry-test?confirm=1"
 *   4. Open Sentry → Issues. Expect two new events (one from
 *      captureException, one from the thrown route error) both
 *      tagged { probe: "sentry-test" }.
 *   5. Confirm the fake credentials below appear as [REDACTED] in
 *      the event message / exception value / breadcrumb data.
 *   6. DELETE this route file. It has no other purpose.
 *
 * Gated on ?confirm=1 so a random probe returns 400 without firing
 * an event (keeps the Sentry quota honest).
 */

// Synthetic — NOT real credentials. Each one matches a regex in the
// redaction beforeSend hook so we can eyeball which patterns fired.
const FAKE_ANTHROPIC = 'sk-ant-XXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const FAKE_OPENAI = 'sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const FAKE_GOOGLE = 'AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const FAKE_META = 'EAA' + 'X'.repeat(60);

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('confirm') !== '1') {
    return NextResponse.json(
      {
        error: 'This is a Sentry verification probe. Add ?confirm=1 to actually trigger the event.',
      },
      { status: 400 },
    );
  }

  // Path 1: explicit captureException with a fake credential in the
  // Error message + extras. Should appear on Sentry with the fake
  // keys REDACTED.
  const explicit = new Error(
    `Sentry probe (explicit) — leaked ${FAKE_ANTHROPIC} and ${FAKE_OPENAI} on purpose.`,
  );
  Sentry.withScope((scope) => {
    scope.setTag('probe', 'sentry-test');
    scope.setTag('probe_path', 'explicit_capture');
    scope.setExtra('fake_google_key', FAKE_GOOGLE);
    scope.setExtra('fake_meta_token', FAKE_META);
    scope.setExtra('access_token', 'sensitive-key-hint-should-scrub');
    Sentry.captureException(explicit);
  });

  // Path 2: throw an unhandled error out of the route handler so
  // onRequestError picks it up. Different fingerprint from Path 1 so
  // both events appear separately in Sentry.
  throw new Error(
    `Sentry probe (unhandled) — ${FAKE_ANTHROPIC} inside a thrown error, Bearer ${FAKE_OPENAI} appended.`,
  );
}
