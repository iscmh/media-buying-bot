'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AI_PROVIDER_META, type AIProviderName } from '@mbb/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { formatDateTime } from '@/lib/format/date';
import {
  disconnectAiProviderAction,
  reverifyAiProviderAction,
  verifyAndSaveProviderKey,
} from './actions';

export interface ProviderCardProps {
  provider: AIProviderName;
  connected: {
    apiKeyVerifiedAt: Date | null;
    lastVerifiedAt: Date | null;
    tier: 'free' | 'pro' | 'premium' | null;
  } | null;
}

export function ProviderCard({ provider, connected }: ProviderCardProps) {
  const meta = AI_PROVIDER_META[provider];

  return (
    <div className="bg-bg-elevated flex flex-col gap-4 rounded-md border p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-fg text-base font-semibold">{meta.label}</h2>
            {connected?.tier && <TierBadge tier={connected.tier} />}
            {connected && <Badge variant="success">Connected</Badge>}
          </div>
          <p className="text-fg-muted mt-1 text-sm">{meta.description}</p>
        </div>
      </header>

      {connected ? (
        <ConnectedBody provider={provider} connected={connected} providerLabel={meta.label} />
      ) : (
        <DisconnectedBody provider={provider} />
      )}

      <footer className="text-fg-muted flex gap-3 text-xs">
        <a
          href={meta.pricingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-fg underline"
        >
          Pricing
        </a>
        <a
          href={meta.apiDocsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-fg underline"
        >
          API docs
        </a>
      </footer>
    </div>
  );
}

function ConnectedBody({
  provider,
  connected,
  providerLabel,
}: {
  provider: AIProviderName;
  connected: NonNullable<ProviderCardProps['connected']>;
  providerLabel: string;
}) {
  const lastVerified = connected.lastVerifiedAt
    ? formatDateTime(connected.lastVerifiedAt)
    : connected.apiKeyVerifiedAt
      ? formatDateTime(connected.apiKeyVerifiedAt)
      : '—';

  const [reverifyPending, startReverify] = React.useTransition();
  const [reverifyMsg, setReverifyMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [disconnectPending, startDisconnect] = React.useTransition();

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
        <span className="text-fg-muted sm:w-32">Last verified</span>
        <span className="text-fg font-mono">{lastVerified}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={reverifyPending}
          onClick={() =>
            startReverify(async () => {
              const r = await reverifyAiProviderAction(provider);
              setReverifyMsg({
                ok: r.ok,
                text: r.ok
                  ? `Refreshed${r.tier ? ` — tier: ${r.tier}` : ''}`
                  : (r.errorMessage ?? 'Re-verify failed.'),
              });
            })
          }
        >
          {reverifyPending ? 'Verifying…' : 'Verify connection'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disconnectPending}
          className="border-[color:var(--destructive-color)]/40 hover:bg-[color:var(--destructive-color)]/10 text-[color:var(--destructive-color)]"
          onClick={() => {
            if (!confirm(`Disconnect ${providerLabel}?`)) return;
            startDisconnect(async () => {
              await disconnectAiProviderAction(provider);
            });
          }}
        >
          {disconnectPending ? 'Disconnecting…' : 'Disconnect'}
        </Button>
        {reverifyMsg && (
          <span
            className={
              reverifyMsg.ok
                ? 'text-fg-muted text-xs'
                : 'text-xs text-[color:var(--destructive-color)]'
            }
          >
            {reverifyMsg.text}
          </span>
        )}
      </div>

      {provider === 'heygen' && connected.tier !== 'premium' && (
        <a
          href="https://app.heygen.com/upgrade"
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg hover:text-fg-muted block text-xs underline"
        >
          Upgrade HeyGen to unlock premium avatars
        </a>
      )}
    </div>
  );
}

function DisconnectedBody({ provider }: { provider: AIProviderName }) {
  const [apiKey, setApiKey] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const inputId = `apiKey-${provider}`;

  return (
    <form
      action={(formData) => {
        formData.set('provider', provider);
        formData.set('apiKey', apiKey);
        setError(null);
        startTransition(async () => {
          const r = await verifyAndSaveProviderKey(formData);
          if (!r.ok) {
            setError(r.errorMessage ?? 'Verification failed.');
            return;
          }
          if (typeof window !== 'undefined') window.location.reload();
        });
      }}
      className="space-y-3 text-sm"
    >
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>API key</Label>
        <div className="relative">
          <input
            id={inputId}
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
        <KeyHint provider={provider} />
      </div>
      {error && <p className="text-xs text-[color:var(--destructive-color)]">{error}</p>}
      <Button type="submit" variant="accent" size="sm" disabled={pending || apiKey.length === 0}>
        {pending ? 'Verifying…' : 'Verify and save'}
      </Button>
    </form>
  );
}

function KeyHint({ provider }: { provider: AIProviderName }) {
  switch (provider) {
    case 'heygen':
      return (
        <p className="text-fg-muted text-xs">Settings → API in HeyGen. Paste the single value.</p>
      );
    case 'replicate':
      return (
        <p className="text-fg-muted text-xs">
          Get a token at{' '}
          <a
            href="https://replicate.com/account/api-tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg underline"
          >
            replicate.com/account/api-tokens
          </a>
          . Starts with <code className="font-mono">r8_</code>.
        </p>
      );
    case 'openai':
      return (
        <p className="text-fg-muted text-xs">
          Get a key at{' '}
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg underline"
          >
            platform.openai.com/api-keys
          </a>
          . Starts with <code className="font-mono">sk-</code>.
        </p>
      );
    case 'wavespeed_ai':
      return (
        <p className="text-fg-muted text-xs">
          Get a key at{' '}
          <a
            href="https://wavespeed.ai/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg underline"
          >
            wavespeed.ai/dashboard
          </a>
          . Starts with <code className="font-mono">wsk_live_</code> or{' '}
          <code className="font-mono">wsk_test_</code>.
        </p>
      );
    default:
      return null;
  }
}

function TierBadge({ tier }: { tier: 'free' | 'pro' | 'premium' }) {
  if (tier === 'premium') return <Badge variant="success">Premium</Badge>;
  if (tier === 'pro') return <Badge variant="outline">Pro</Badge>;
  return <Badge variant="outline">Free</Badge>;
}
