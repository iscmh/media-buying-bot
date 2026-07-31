'use client';

import * as React from 'react';
import { logClientError } from '@/lib/client-error-logger';

/**
 * Polish-25.7 Commit 46: per-route client error boundary.
 *
 * Next.js App Router renders this whenever a client component
 * inside `app/*` throws during render. On mount we ship the error
 * to /api/log-error via the client logger; UI shows a compact
 * recovery card with a reset button (Next's built-in retry hook).
 *
 * Also emits to Sentry via the client init's autoinstrumentation —
 * this file's job is the first-party error_log write, not Sentry.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    logClientError({
      source: 'client_boundary',
      sourceName: 'app/error.tsx',
      error,
      context: { digest: error.digest ?? null },
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-fg text-lg font-semibold">Something went wrong on this page.</h1>
      <p className="text-fg-muted text-sm">
        The error has been logged. Try again. If it keeps happening, drop a note in the beta
        feedback channel.
      </p>
      {error.digest && <p className="text-fg-subtle font-mono text-xs">Ref: {error.digest}</p>}
      <button
        type="button"
        onClick={() => reset()}
        className="border-fg/30 hover:bg-bg-surfaceHover inline-flex items-center rounded-sm border px-3 py-1.5 text-sm"
      >
        Try again
      </button>
    </div>
  );
}
