'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import type { AIProviderName } from '@mbb/shared';
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
import { disconnectAiProviderAction } from './actions';

interface Props {
  provider: AIProviderName;
  providerLabel: string;
  verificationMethod: 'api' | 'format_only';
  apiKeyVerifiedAt: Date | null;
}

function DisconnectButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? 'Disconnecting…' : 'Yes, disconnect'}
    </Button>
  );
}

export function ProviderConnectedSummary({
  providerLabel,
  verificationMethod,
  apiKeyVerifiedAt,
}: Props) {
  const verified = apiKeyVerifiedAt ? apiKeyVerifiedAt.toLocaleString() : 'unknown';

  return (
    <div className="space-y-6">
      <div className="bg-card space-y-3 rounded-lg border p-6 text-sm">
        <Row label="Provider" value={<span className="font-semibold">{providerLabel}</span>} />
        <Row
          label="Verification"
          value={
            verificationMethod === 'api'
              ? 'Live API check'
              : 'Format-only (verifies at first generation)'
          }
        />
        <Row label="Last verified" value={verified} />
      </div>

      <div className="bg-card flex flex-col gap-3 rounded-lg border p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium">Switch or disconnect</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Disconnecting clears your stored key, pauses the bot, and sends you back to the provider
            picker. You&rsquo;ll need to re-paste your key (or a different provider&rsquo;s key) to
            resume.
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
              <DialogTitle>Disconnect {providerLabel}?</DialogTitle>
              <DialogDescription>
                This pauses the bot and clears your stored credential. You&rsquo;ll be sent to the
                provider picker. Continue?
              </DialogDescription>
            </DialogHeader>
            <form action={disconnectAiProviderAction} className="flex justify-end gap-2">
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
