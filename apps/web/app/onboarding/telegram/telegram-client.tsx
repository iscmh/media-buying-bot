'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getTelegramLinkStatus } from './actions';

interface Props {
  code: string;
  botUsername: string;
}

const POLL_INTERVAL_MS = 3000;

export function TelegramLinkClient({ code, botUsername }: Props) {
  const router = useRouter();
  const [copied, setCopied] = React.useState(false);
  const [linked, setLinked] = React.useState(false);

  // Poll for status flip from 'pending' to 'active'.
  React.useEffect(() => {
    if (linked) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await getTelegramLinkStatus();
        if (cancelled) return;
        if (result.status === 'active') {
          setLinked(true);
          // brief moment for the success state, then redirect to dashboard.
          setTimeout(() => router.push('/dashboard'), 1200);
        }
      } catch {
        // Transient errors during polling are non-fatal — just retry.
      }
    };
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    void tick(); // immediate first check
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [linked, router]);

  const command = `/start ${code}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Some browsers reject clipboard API without user gesture; ignore silently.
    }
  }

  if (linked) {
    return (
      <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-green-500/15">
          <Check className="h-5 w-5 text-green-600" />
        </div>
        <p className="font-semibold">Telegram linked.</p>
        <p className="text-muted-foreground mt-1 text-sm">Taking you to the dashboard…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ol className="bg-card list-inside list-decimal space-y-2 rounded-lg border p-6 text-sm">
        <li>
          Open Telegram and search for{' '}
          <a
            href={`https://t.me/${botUsername}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono font-semibold underline"
          >
            @{botUsername}
          </a>
          .
        </li>
        <li>
          Send the bot this message exactly:
          <div className="bg-background mt-2 flex items-center gap-2 rounded-md border p-3">
            <code className="flex-1 break-all font-mono text-sm">{command}</code>
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ml-1">{copied ? 'Copied' : 'Copy'}</span>
            </Button>
          </div>
        </li>
        <li>Wait — this page will move forward as soon as the bot confirms.</li>
      </ol>

      <div className="text-muted-foreground flex items-center gap-3 text-sm">
        <span className="bg-muted-foreground/40 inline-flex h-2 w-2 animate-pulse rounded-full" />
        Waiting for confirmation from Telegram…
      </div>

      <p className="text-muted-foreground text-xs">
        Code expires 15 minutes after generation. If it expires, refresh this page to get a new one.
      </p>
    </div>
  );
}
