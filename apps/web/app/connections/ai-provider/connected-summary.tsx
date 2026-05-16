'use client';

import { formatDateTime } from '@/lib/format/date';

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
  const verified = apiKeyVerifiedAt ? formatDateTime(apiKeyVerifiedAt) : 'unknown';

  return (
    <div className="space-y-4">
      <div className="bg-bg-elevated space-y-3 rounded-md border p-5 text-sm">
        <Row
          label="Provider"
          value={<span className="text-fg font-semibold">{providerLabel}</span>}
        />
        <Row
          label="Verification"
          value={
            verificationMethod === 'api'
              ? 'Live API check'
              : 'Format-only (verifies at first generation)'
          }
        />
        <Row label="Last verified" value={<span className="font-mono">{verified}</span>} />
      </div>

      <div className="bg-bg-elevated flex flex-col gap-3 rounded-md border p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-fg font-medium">Switch or disconnect</p>
          <p className="text-fg-muted mt-1 text-sm">
            Disconnecting clears your stored key, pauses the bot, and sends you back to the provider
            picker.
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
              <DialogTitle>Disconnect {providerLabel}?</DialogTitle>
              <DialogDescription>
                This pauses the bot and clears your stored credential. You&rsquo;ll be sent to the
                provider picker.
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
      <span className="text-fg-muted sm:w-44">{label}</span>
      <span className="text-fg font-medium">{value}</span>
    </div>
  );
}
