'use client';

import { formatDate, formatDateTime } from '@/lib/format/date';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { disconnectMetaAction } from './actions';

interface Props {
  businessManagerId: string;
  adAccountIds: string[];
  tokenExpiresAt: Date | null;
  lastVerifiedAt: Date | null;
  /** Polish-3.5: ad account currency + tz + page count for the summary card. */
  accountCurrency: string | null;
  accountTimezone: string | null;
  pageCount: number;
}

function DisconnectButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? 'Disconnecting…' : 'Yes, disconnect'}
    </Button>
  );
}

export function MetaConnectedSummary({
  businessManagerId,
  adAccountIds,
  tokenExpiresAt,
  lastVerifiedAt,
  accountCurrency,
  accountTimezone,
  pageCount,
}: Props) {
  const expiry = tokenExpiresAt ? formatDate(tokenExpiresAt) : 'never';
  const verified = lastVerifiedAt ? formatDateTime(lastVerifiedAt) : 'unknown';

  return (
    <div className="space-y-4">
      <div className="bg-bg-elevated space-y-3 rounded-md border p-5 text-sm">
        <Row
          label="Business Manager ID"
          value={<code className="font-mono">{businessManagerId}</code>}
        />
        <Row label="Managed ad accounts" value={`${adAccountIds.length}`} />
        <Row
          label="Ad account IDs"
          value={
            <ul className="space-y-0.5 font-mono text-xs">
              {adAccountIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          }
        />
        <Row
          label="Account currency"
          value={
            accountCurrency ? (
              <span className="font-mono">{accountCurrency}</span>
            ) : (
              <span className="text-fg-muted text-xs">not set — reconnect Meta to capture</span>
            )
          }
        />
        <Row
          label="Account timezone"
          value={
            accountTimezone ? (
              <span className="font-mono">{accountTimezone}</span>
            ) : (
              <span className="text-fg-muted text-xs">not set</span>
            )
          }
        />
        <Row
          label="Facebook Pages"
          value={<span className="font-mono">{pageCount} cached at connect time</span>}
        />
        <Row label="Token expires" value={<span className="font-mono">{expiry}</span>} />
        <Row label="Last verified" value={<span className="font-mono">{verified}</span>} />
      </div>

      <div className="bg-bg-elevated flex flex-col gap-3 rounded-md border p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-fg font-medium">Disconnect Meta</p>
          <p className="text-fg-muted mt-1 text-sm">
            Revokes the token at Meta (best-effort), clears it locally, pauses the bot, and sends
            you back to the Meta onboarding step.
          </p>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="border-[color:var(--destructive-color)]/40 hover:bg-[color:var(--destructive-color)]/10 shrink-0 text-[color:var(--destructive-color)]"
            >
              Disconnect
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect Meta?</DialogTitle>
              <DialogDescription>
                This pauses the bot and clears your stored Meta token. You&rsquo;ll be sent back to
                the Meta onboarding step.
              </DialogDescription>
            </DialogHeader>
            <form action={disconnectMetaAction} className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <DisconnectButton />
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="text-fg-muted sm:w-44">{label}</span>
      <span className="text-fg font-medium">{value}</span>
    </div>
  );
}
