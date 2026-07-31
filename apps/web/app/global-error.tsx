'use client';

import * as React from 'react';
import { logClientError } from '@/lib/client-error-logger';

/**
 * Polish-25.7 Commit 46: root-level client error boundary.
 *
 * Only fires when app/error.tsx itself, the root layout, or another
 * top-level surface throws. Must include its own <html>/<body>
 * because the layout is unmounted at this point (Next.js requirement).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    logClientError({
      source: 'client_boundary',
      sourceName: 'app/global-error.tsx',
      error,
      context: { digest: error.digest ?? null },
    });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-sans-serif, system-ui', padding: 24 }}>
        <div style={{ maxWidth: 520, margin: '10vh auto' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
            Something went badly wrong.
          </h1>
          <p style={{ color: '#888', fontSize: 14, marginBottom: 8 }}>
            The failure has been logged. Reload the app; if this keeps happening, ping the beta
            feedback channel.
          </p>
          {error.digest && (
            <p style={{ color: '#666', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
              Ref: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 12,
              padding: '6px 12px',
              border: '1px solid #999',
              borderRadius: 4,
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
