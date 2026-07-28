'use client';

import * as React from 'react';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { approveKillAction, approveScaleAction, skipKillAction, skipScaleAction } from '../actions';

/**
 * Polish-25.6 Commit 34: inline Approve/Skip buttons on the /launched
 * table. Replaces the Telegram tap-to-confirm flow for MVP (Telegram
 * was deprecated in this same commit — see settings/connections).
 *
 * Two variants: `kind="kill"` for kill_recommended rows, `kind="scale"`
 * for scale_recommended. Both hit the same underlying Inngest event
 * (`approval/decision.received`) the Telegram callback fires, so no
 * worker code changes.
 *
 * UI: two small buttons + a tiny status caption underneath. Optimistic
 * disable on click; on ok, the caption flips to "queued" and the page
 * revalidation fetches the new state. On error, red inline message.
 */

interface Props {
  launchedAdId: string;
  kind: 'kill' | 'scale';
  /** Optional dollar figure to show ($X → $Y) for scale recs. */
  scaleFrom?: number | null;
  scaleTo?: number | null;
}

export function ApprovalButtons({ launchedAdId, kind, scaleFrom, scaleTo }: Props) {
  const [pending, startTransition] = React.useTransition();
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  function fire(kind: 'kill' | 'scale', decision: 'confirm' | 'skip') {
    setMsg(null);
    startTransition(async () => {
      const fn =
        kind === 'kill'
          ? decision === 'confirm'
            ? approveKillAction
            : skipKillAction
          : decision === 'confirm'
            ? approveScaleAction
            : skipScaleAction;
      const r = await fn(launchedAdId);
      setMsg({ ok: r.ok, text: r.message });
    });
  }

  const label = kind === 'kill' ? 'Kill' : 'Scale';
  const approveClass =
    kind === 'kill'
      ? 'border-[color:var(--accent-negative)]/50 text-[color:var(--accent-negative)] hover:bg-[color:var(--accent-negative)]/10'
      : 'border-[color:var(--accent-positive)]/50 text-[color:var(--accent-positive)] hover:bg-[color:var(--accent-positive)]/10';

  return (
    <div className="flex flex-col gap-1">
      {kind === 'scale' && scaleFrom != null && scaleTo != null && (
        <p className="text-fg-subtle font-mono text-[10px]">
          ${scaleFrom.toFixed(2)} → ${scaleTo.toFixed(2)}
        </p>
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => fire(kind, 'confirm')}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium transition-colors disabled:opacity-50',
            approveClass,
          )}
          aria-label={`Approve ${label}`}
        >
          <Check className="h-3 w-3" />
          Approve
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => fire(kind, 'skip')}
          className="border-border text-fg-muted hover:bg-bg-surfaceHover inline-flex h-6 items-center gap-1 rounded-sm border px-1.5 text-xs transition-colors disabled:opacity-50"
          aria-label={`Skip ${label}`}
        >
          <X className="h-3 w-3" />
          Skip
        </button>
      </div>
      {msg && (
        <p
          className={cn(
            'text-[10px] leading-tight',
            msg.ok ? 'text-fg-muted' : 'text-[color:var(--accent-negative)]',
          )}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}
