'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Eye, EyeOff } from 'lucide-react';
import type { ToolProviderName } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { disconnectToolAction, verifyAndSaveToolKey } from './actions';

interface Props {
  provider: ToolProviderName;
  label: string;
  role: string;
  description: string;
  apiDocsUrl: string;
  keyHint: string;
  connected: boolean;
  verifiedDisplay: string | null;
}

function VerifyButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="accent" disabled={pending} size="sm">
      {pending ? 'Saving…' : 'Verify and save'}
    </Button>
  );
}

function DisconnectButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? 'Disconnecting…' : 'Yes, disconnect'}
    </Button>
  );
}

export function ToolCard({
  provider,
  label,
  role,
  description,
  apiDocsUrl,
  keyHint,
  connected,
  verifiedDisplay,
}: Props) {
  const [reveal, setReveal] = React.useState(false);
  const [apiKey, setApiKey] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(formData: FormData) {
    setError(null);
    const result = await verifyAndSaveToolKey(formData);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Verification failed.');
      return;
    }
    if (typeof window !== 'undefined') window.location.reload();
  }

  return (
    <article className="bg-card space-y-4 rounded-lg border p-6">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{label}</h2>
          <p className="text-muted-foreground text-xs">{role}</p>
        </div>
        {connected && (
          <span className="inline-flex items-center gap-1 text-xs text-green-700">
            <span className="h-2 w-2 rounded-full bg-green-600" aria-hidden />
            Connected · verified {verifiedDisplay}
          </span>
        )}
      </header>

      <p className="text-muted-foreground text-sm">{description}</p>

      {connected ? (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="text-destructive">
              Disconnect
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect {label}?</DialogTitle>
              <DialogDescription>
                This pauses the bot, clears your stored {label} key, and lets you re-paste a new
                one. Other providers stay connected.
              </DialogDescription>
            </DialogHeader>
            <form action={disconnectToolAction} className="flex justify-end gap-2">
              <input type="hidden" name="provider" value={provider} />
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <DisconnectButton />
            </form>
          </DialogContent>
        </Dialog>
      ) : (
        <form action={handleSubmit} className="space-y-3">
          <input type="hidden" name="provider" value={provider} />
          <div className="space-y-1.5">
            <Label htmlFor={`${provider}-key`}>API key</Label>
            <div className="relative">
              <input
                id={`${provider}-key`}
                name="apiKey"
                type={reveal ? 'text' : 'password'}
                required
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 pr-10 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                aria-label={reveal ? 'Hide key' : 'Reveal key'}
                className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
              >
                {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-muted-foreground text-xs">
              {keyHint}{' '}
              <a href={apiDocsUrl} target="_blank" rel="noreferrer" className="underline">
                Docs
              </a>
            </p>
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <VerifyButton />
        </form>
      )}
    </article>
  );
}
