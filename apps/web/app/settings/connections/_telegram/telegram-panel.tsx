'use client';

import * as React from 'react';
import { CheckCircle2, Copy, RefreshCcw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { disconnectTelegramAction } from '@/app/connections/telegram/actions';
import { generateTelegramLinkCodeAction } from '@/app/connections/telegram/actions';

/**
 * Polish-25.8 Commit 47: Telegram tab restored.
 *
 * Connected case: shows tg_username + linked_at + disconnect button.
 * Disconnected case: "Generate link code" button + step-by-step
 * instructions to send `/link <CODE>` to the bot. Code + bot handle
 * copy-to-clipboard for one-tap paste on mobile.
 *
 * Bot username is read from NEXT_PUBLIC_TELEGRAM_BOT_USERNAME so the
 * "Open bot" deep-link works. Missing env var → link is hidden,
 * instructions still work by having the user search the bot name in
 * Telegram.
 */

interface Props {
  connected: boolean;
  tgUsername: string | null;
  linkedAtIso: string | null;
  botUsername: string | null;
}

export function TelegramPanel({ connected, tgUsername, linkedAtIso, botUsername }: Props) {
  const [code, setCode] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleGenerate() {
    setPending(true);
    setError(null);
    try {
      const result = await generateTelegramLinkCodeAction();
      if (result.ok && result.code) {
        setCode(result.code);
      } else {
        setError(result.error ?? 'Could not generate link code.');
      }
    } finally {
      setPending(false);
    }
  }

  if (connected) {
    return (
      <div className="space-y-4">
        <div className="border-[color:var(--accent-positive)]/40 bg-[color:var(--accent-positive)]/5 flex items-start gap-2 rounded-md border p-3 text-sm">
          <CheckCircle2
            className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--accent-positive)]"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-fg font-medium">Connected{tgUsername ? ` as @${tgUsername}` : ''}</p>
            <p className="text-fg-muted mt-0.5 text-xs">
              {linkedAtIso
                ? `Linked ${new Date(linkedAtIso).toISOString().slice(0, 16).replace('T', ' ')} UTC`
                : ''}
            </p>
            <p className="text-fg-muted mt-1 text-xs">
              You&apos;ll get kill / scale approval prompts + real-time launch alerts in this chat.
              Use /help in Telegram to see all commands.
            </p>
          </div>
        </div>
        <form action={disconnectTelegramAction}>
          <Button type="submit" variant="outline" size="sm">
            <Unlink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Disconnect Telegram
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-fg-muted text-sm leading-relaxed">
        <p>
          Link Telegram to approve kill / scale recommendations on the go and get real-time launch +
          rejection alerts.
        </p>
      </div>

      {code ? (
        <div className="border-border-subtle bg-bg-surface space-y-3 rounded-md border p-4">
          <div>
            <p className="text-fg-muted text-xs uppercase tracking-wider">Your link code</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="text-fg bg-bg-inset border-border rounded-sm border px-3 py-1.5 font-mono text-lg">
                {code}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(code)}
                className="text-fg-muted hover:text-fg inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                aria-label="Copy code"
              >
                <Copy className="h-3 w-3" aria-hidden /> Copy
              </button>
            </div>
            <p className="text-fg-subtle mt-1 text-[11px]">Expires in 15 minutes. Single-use.</p>
          </div>
          <ol className="text-fg-muted list-decimal space-y-1.5 pl-5 text-xs">
            <li>
              Open{' '}
              {botUsername ? (
                <a
                  href={`https://t.me/${botUsername}?start=${code}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg underline-offset-4 hover:text-[color:var(--accent-amber)] hover:underline"
                >
                  @{botUsername}
                </a>
              ) : (
                <span>the Ads Bot in Telegram</span>
              )}
              .
            </li>
            <li>
              Send:{' '}
              <code className="text-fg bg-bg-inset rounded-sm px-1 font-mono text-[11px]">
                /link {code}
              </code>
            </li>
            <li>Bot replies with a confirmation.</li>
          </ol>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleGenerate}
              disabled={pending}
            >
              <RefreshCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Regenerate
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" onClick={handleGenerate} disabled={pending}>
          {pending ? 'Generating…' : 'Generate link code'}
        </Button>
      )}

      {error && (
        <p className="text-xs text-[color:var(--accent-negative)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
