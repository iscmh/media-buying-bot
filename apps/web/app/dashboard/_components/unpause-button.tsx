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
import { unpauseUserAction } from './pause-banner-actions';

interface Props {
  openPauseCount: number;
  /**
   * Polish-25.7 Commit 43: threaded through so the dialog can warn on
   * "you're about to unpause with meta_disconnected still active — the
   * next launch will just cascade-pause you again."
   */
  openReasons: string[];
  metaStillDisconnected: boolean;
}

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Resuming…' : 'Yes, resume'}
    </Button>
  );
}

/**
 * Two-click unpause: open dialog, confirm, action runs. Single-click is
 * intentionally NOT supported — operators have been burned enough that
 * "Unpause" deserves a deliberate moment.
 */
export function UnpauseButton({ openPauseCount, openReasons, metaStillDisconnected }: Props) {
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    const result = await unpauseUserAction();
    if (!result.ok) {
      setError(result.message);
    }
    // Success path: revalidatePath('/dashboard') in the action triggers a
    // re-render that hides the banner. No client navigation needed.
  }

  const pluralLabel = `${openPauseCount} pause${openPauseCount === 1 ? '' : 's'}`;
  // Polish-25.7 Commit 43: auto-repause protection. If one of the open
  // reasons is meta_disconnected AND Meta is still disconnected, the
  // very next launch will cascade-pause the user again. Warn loudly so
  // the operator reconnects first.
  const willAutoRepause = openReasons.includes('meta_disconnected') && metaStillDisconnected;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="text-destructive">
          Unpause
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resume bot operations?</DialogTitle>
          <DialogDescription>
            All disconnected services have been reconnected? The underlying issue is resolved?
          </DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">
          {pluralLabel} open since the bot was last running. Resuming closes them all.
        </p>
        {willAutoRepause && (
          <div
            className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
            role="alert"
          >
            <p className="font-semibold">Meta is still disconnected.</p>
            <p className="mt-1 text-xs">
              Unpausing now will auto-pause the bot again on the next launch attempt. Reconnect Meta
              first at Settings → Connections → Meta, then come back and unpause.
            </p>
          </div>
        )}
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <form action={handleSubmit} className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <ConfirmButton />
        </form>
      </DialogContent>
    </Dialog>
  );
}
