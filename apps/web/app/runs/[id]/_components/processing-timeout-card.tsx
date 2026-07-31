'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { recheckPolish25MakeugcAction, type RecheckPolish25Result } from '../actions';

/**
 * Polish-25.6 Commit 37: run-detail "still generating" panel for jobs
 * that hit the worker's poll cap (60 min) while MakeUGC status was
 * still processing.
 *
 * Distinct from the red "Generation failed" card — this render fires
 * only when `metadata.polish25_processing_timeout === true`. Credit
 * is already charged on MakeUGC; the video usually lands eventually
 * and the Recheck button recovers it via the server action.
 *
 * Recheck action returns one of three shapes:
 *   - completed        → we router.refresh() so the page swaps to the
 *                        normal completed view + variant grid.
 *   - failed           → we router.refresh() so the page swaps to the
 *                        normal red error card with the real reason.
 *   - still_processing → we stay on this card + show the reply message
 *                        so the operator sees the recheck actually ran.
 */

interface Props {
  jobId: string;
  stuckVideoId: string;
  timeoutAt: string | null;
}

export function ProcessingTimeoutCard({ jobId, stuckVideoId, timeoutAt }: Props) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  function onRecheck() {
    setMsg(null);
    startTransition(async () => {
      const r: RecheckPolish25Result = await recheckPolish25MakeugcAction(jobId);
      if (!r.ok) {
        setMsg({ ok: false, text: r.message });
        return;
      }
      if (r.status === 'completed' || r.status === 'failed') {
        // Server-side revalidatePath already fired; router.refresh forces
        // the RSC boundary to re-fetch so the whole page swaps to the
        // canonical completed / failed view.
        router.refresh();
        return;
      }
      // still_processing — show the message, leave the card up.
      setMsg({ ok: true, text: r.message });
    });
  }

  return (
    <div className="bg-bg-surface rounded-md border p-5 text-sm">
      <p className="text-fg mb-1 text-base font-semibold">Still generating on Instant UGC.</p>
      <p className="text-fg-muted leading-relaxed">
        The video hit the worker&apos;s 60-minute poll cap but the render provider still reports it
        as processing. Credit is already charged. The render lands eventually. Come back in a few
        minutes and click Recheck to poll for completion.
      </p>
      <dl className="text-fg-subtle mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        <dt>videoId:</dt>
        <dd className="text-fg break-all">{stuckVideoId}</dd>
        {timeoutAt && (
          <>
            <dt>timed out:</dt>
            <dd className="text-fg">{timeoutAt}</dd>
          </>
        )}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="accent" size="sm" disabled={pending} onClick={onRecheck}>
          {pending ? 'Rechecking…' : 'Recheck status'}
        </Button>
      </div>
      {msg && (
        <p
          className={cn(
            'mt-3 text-xs',
            msg.ok ? 'text-fg-muted' : 'text-[color:var(--accent-negative)]',
          )}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}
