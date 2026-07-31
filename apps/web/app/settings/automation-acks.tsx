'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/format/date';
import { acknowledgeKillAction, acknowledgeScaleAction } from './actions';

interface Props {
  killAcknowledgedAt: string | null;
  scaleAcknowledgedAt: string | null;
}

/**
 * Phase 5: surface the two automation acks the bot needs before it can
 * execute a kill or scale on the user's behalf. Each card shows current
 * state and, when un-acked, opens a one-time confirmation dialog
 * explaining what the action means.
 *
 * Polish-25.6 Commit 34: copy rewritten to describe the web-based
 * approval flow (Approve/Skip buttons on /launched) since Telegram
 * was deprecated for MVP. Server actions unchanged — the ack timestamp
 * is still what gates the underlying action, whether it fires from
 * Telegram (post-launch) or the /launched inline button (MVP).
 */
export function AutomationAcks({ killAcknowledgedAt, scaleAcknowledgedAt }: Props) {
  const [killAt, setKillAt] = React.useState(killAcknowledgedAt);
  const [scaleAt, setScaleAt] = React.useState(scaleAcknowledgedAt);
  const [showKill, setShowKill] = React.useState(false);
  const [showScale, setShowScale] = React.useState(false);
  const [killPending, setKillPending] = React.useState(false);
  const [scalePending, setScalePending] = React.useState(false);

  async function confirmKill() {
    setKillPending(true);
    try {
      const r = await acknowledgeKillAction();
      if (r.ok) {
        setKillAt(new Date().toISOString());
        setShowKill(false);
      }
    } finally {
      setKillPending(false);
    }
  }

  async function confirmScale() {
    setScalePending(true);
    try {
      const r = await acknowledgeScaleAction();
      if (r.ok) {
        setScaleAt(new Date().toISOString());
        setShowScale(false);
      }
    } finally {
      setScalePending(false);
    }
  }

  return (
    <section className="mb-8 space-y-3">
      <h2 className="text-lg font-semibold">Automation acks</h2>
      <p className="text-muted-foreground text-xs">
        One-time confirmations the bot checks before executing a kill or scale on your behalf.
      </p>

      <article className="bg-card flex items-start justify-between gap-3 rounded-lg border p-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Kill (pause ad)</p>
          <p className="text-muted-foreground text-xs">
            {killAt
              ? `Acknowledged ${formatDateTime(new Date(killAt))}`
              : 'Kill pauses the ad on Meta and stops spending. Reversible from Ads Manager.'}
          </p>
        </div>
        {killAt ? (
          <span className="text-xs text-[color:var(--accent-positive)]">✓ Ready</span>
        ) : (
          <Button type="button" size="sm" onClick={() => setShowKill(true)}>
            Acknowledge
          </Button>
        )}
      </article>

      <article className="bg-card flex items-start justify-between gap-3 rounded-lg border p-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Scale (raise daily budget)</p>
          <p className="text-muted-foreground text-xs">
            {scaleAt
              ? `Acknowledged ${formatDateTime(new Date(scaleAt))}`
              : "Scaling raises the ad set's daily budget. Irreversible spend until you pause."}
          </p>
        </div>
        {scaleAt ? (
          <span className="text-xs text-[color:var(--accent-positive)]">✓ Ready</span>
        ) : (
          <Button type="button" size="sm" onClick={() => setShowScale(true)}>
            Acknowledge
          </Button>
        )}
      </article>

      <Dialog open={showKill} onOpenChange={setShowKill}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acknowledge kill action</DialogTitle>
            <DialogDescription>
              When the bot recommends killing an ad and you tap Approve on the /launched page, the
              ad is set to PAUSED on your Meta account. It stops spending immediately. You can
              resume it manually in Ads Manager at any time.
            </DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-xs">
            One-time ack. Subsequent kills don&apos;t prompt this dialog.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowKill(false)}
              disabled={killPending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={confirmKill} disabled={killPending}>
              {killPending ? 'Saving…' : 'I understand'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showScale} onOpenChange={setShowScale}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acknowledge scale action</DialogTitle>
            <DialogDescription>
              When the bot recommends scaling an ad and you tap Approve on the /launched page, the
              ad set&rsquo;s daily_budget is raised on Meta. Spend goes up immediately. The bot
              enforces hard ceilings (2× per scale event, your settings max, daily launch cap; +25%
              for your first 5 scales) but the increase itself can&apos;t be reversed, only paused.
            </DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-xs">
            One-time ack. Subsequent scales don&apos;t prompt this dialog.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowScale(false)}
              disabled={scalePending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={confirmScale} disabled={scalePending}>
              {scalePending ? 'Saving…' : 'I understand'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
