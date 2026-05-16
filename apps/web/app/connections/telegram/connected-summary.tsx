'use client';

import { formatDateTime } from '@/lib/format/date';

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
import { disconnectTelegramAction } from './actions';

interface Props {
  tgChatId: string;
  tgUsername: string | null;
  linkedAt: Date | null;
}

function DisconnectButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? 'Disconnecting…' : 'Yes, disconnect'}
    </Button>
  );
}

export function TelegramConnectedSummary({ tgChatId, tgUsername, linkedAt }: Props) {
  const linked = linkedAt ? formatDateTime(linkedAt) : 'unknown';

  return (
    <div className="space-y-4">
      <div className="bg-bg-elevated space-y-3 rounded-md border p-5 text-sm">
        <Row
          label="Telegram username"
          value={tgUsername ? <code className="font-mono">@{tgUsername}</code> : 'not provided'}
        />
        <Row label="Chat ID" value={<code className="font-mono">{tgChatId}</code>} />
        <Row label="Linked" value={<span className="font-mono">{linked}</span>} />
      </div>

      <div className="bg-bg-elevated flex flex-col gap-3 rounded-md border p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-fg font-medium">Disconnect Telegram</p>
          <p className="text-fg-muted mt-1 text-sm">
            Sends a farewell message to the bot, clears the chat link, pauses the bot, and sends you
            back to the Telegram onboarding step.
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
              <DialogTitle>Disconnect Telegram?</DialogTitle>
              <DialogDescription>
                This pauses the bot and clears your chat link. You&rsquo;ll be sent to the Telegram
                onboarding step to reconnect.
              </DialogDescription>
            </DialogHeader>
            <form action={disconnectTelegramAction} className="flex justify-end gap-2">
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
