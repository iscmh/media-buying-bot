'use client';

import * as React from 'react';
import { CREDIT_TOPUP_PACKS } from '@mbb/shared';
import { startTopupCheckout } from '@/app/settings/credits/actions';

/**
 * Polish-29.0.3 Commit 113: three top-up pack buttons. Client
 * component so we can show an inline error under the button that
 * failed (env not configured, Whop 500, session expired) without
 * throwing at the page level.
 *
 * On click:
 *   1. Fire startTopupCheckout(sku).
 *   2. On success the action redirects — the browser navigates to
 *      Whop; this handler never returns.
 *   3. On failure we get {ok:false, errorMessage} back and render it
 *      inline; the button re-enables so the user can retry.
 */
export function TopupButtons({ compact = false }: { compact?: boolean }) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function onClick(sku: string) {
    setError(null);
    setPending(sku);
    try {
      const res = await startTopupCheckout(sku);
      // The redirect() call in the action throws — control only reaches
      // here on failure. Guard for the ok:true case anyway.
      if (!res.ok) {
        setError(res.errorMessage ?? 'Something went wrong. Please try again.');
      }
    } catch (err) {
      // NEXT_REDIRECT is a benign throw; the browser is navigating away.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('NEXT_REDIRECT') && !message.includes('NEXT_HTTP_ERROR_FALLBACK')) {
        setError(message);
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <div
        className={
          compact
            ? 'grid grid-cols-1 gap-2 sm:grid-cols-3'
            : 'grid grid-cols-1 gap-3 sm:grid-cols-3'
        }
      >
        {CREDIT_TOPUP_PACKS.map((pack) => {
          const busy = pending === pack.sku;
          const total = pack.credits + pack.bonusCredits;
          const showBonus = pack.bonusCredits > 0;
          return (
            <button
              key={pack.sku}
              type="button"
              onClick={() => onClick(pack.sku)}
              disabled={busy || pending !== null}
              className={
                'border-border bg-bg-surface hover:border-fg-muted hover:bg-bg-surfaceHover group flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition disabled:cursor-progress disabled:opacity-60'
              }
              aria-busy={busy}
            >
              <span className="text-fg text-sm font-semibold tabular-nums">
                {total.toLocaleString()} credits
              </span>
              {showBonus && (
                <span className="text-[11px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                  incl. +{pack.bonusCredits.toLocaleString()} bonus
                </span>
              )}
              <span className="text-fg-muted mt-1 text-xs tabular-nums">
                ${pack.usd.toLocaleString()}
                {busy && <span className="text-fg-subtle ml-2">Redirecting…</span>}
              </span>
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
