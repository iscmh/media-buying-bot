'use client';

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
}: Props) {
  const expiry = tokenExpiresAt ? tokenExpiresAt.toLocaleDateString() : 'never';
  const verified = lastVerifiedAt ? lastVerifiedAt.toLocaleString() : 'unknown';

  return (
    <div className="space-y-6">
      <div className="bg-card space-y-3 rounded-lg border p-6 text-sm">
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
        <Row label="Token expires" value={expiry} />
        <Row label="Last verified" value={verified} />
      </div>

      <div className="bg-card flex flex-col gap-3 rounded-lg border p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium">Disconnect Meta</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Revokes the token at Meta (best-effort), clears it locally, pauses the bot, and sends
            you back to the Meta onboarding step.
          </p>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" className="text-destructive">
              Disconnect
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect Meta?</DialogTitle>
              <DialogDescription>
                This pauses the bot and clears your stored Meta token. You&rsquo;ll be sent to the
                Meta onboarding step to reconnect. Continue?
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
      <span className="text-muted-foreground sm:w-44">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
