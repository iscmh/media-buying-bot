'use client';

import { formatDateTime } from '@/lib/format/date';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import type { AIProviderName } from '@mbb/shared';
import { Badge } from '@/components/ui/badge';
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
import { disconnectAiProviderAction, reverifyAiProviderAction } from './actions';

interface Props {
  provider: AIProviderName;
  providerLabel: string;
  verificationMethod: 'api' | 'format_only';
  apiKeyVerifiedAt: Date | null;
  lastVerifiedAt: Date | null;
  tier: 'free' | 'pro' | 'premium' | null;
}

function DisconnectButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? 'Disconnecting…' : 'Yes, disconnect'}
    </Button>
  );
}

function ReverifyButton() {
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<{ ok?: boolean; message?: string } | null>(null);
  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await reverifyAiProviderAction();
            setResult({
              ok: r.ok,
              message: r.ok
                ? `Refreshed${r.tier ? ` — tier: ${r.tier}` : ''}`
                : (r.errorMessage ?? 'Re-verify failed.'),
            });
          })
        }
      >
        {pending ? 'Re-verifying…' : 'Verify connection'}
      </Button>
      {result?.message && (
        <span
          className={
            result.ok ? 'text-fg-muted text-xs' : 'text-xs text-[color:var(--destructive-color)]'
          }
        >
          {result.message}
        </span>
      )}
    </div>
  );
}

export function ProviderConnectedSummary({
  provider,
  providerLabel,
  verificationMethod,
  apiKeyVerifiedAt,
  lastVerifiedAt,
  tier,
}: Props) {
  const verified = apiKeyVerifiedAt ? formatDateTime(apiKeyVerifiedAt) : 'unknown';
  const lastVerified = lastVerifiedAt ? formatDateTime(lastVerifiedAt) : '—';
  const isHeyGen = provider === 'heygen';

  return (
    <div className="space-y-4">
      <div className="bg-bg-elevated space-y-3 rounded-md border p-5 text-sm">
        <Row
          label="Provider"
          value={
            <span className="flex items-center gap-2">
              <span className="text-fg font-semibold">{providerLabel}</span>
              {tier && <TierBadge tier={tier} />}
            </span>
          }
        />
        <Row
          label="Verification"
          value={
            verificationMethod === 'api'
              ? 'Live API check'
              : 'Format-only (verifies at first generation)'
          }
        />
        <Row label="Connected" value={<span className="font-mono">{verified}</span>} />
        <Row label="Last verified" value={<span className="font-mono">{lastVerified}</span>} />
        <Row label="" value={<ReverifyButton />} />
        {isHeyGen && tier !== 'premium' && (
          <Row
            label=""
            value={
              <a
                href="https://app.heygen.com/upgrade"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg hover:text-fg-muted text-sm underline transition-colors"
              >
                Upgrade HeyGen to unlock premium avatars
              </a>
            }
          />
        )}
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

function TierBadge({ tier }: { tier: 'free' | 'pro' | 'premium' }) {
  if (tier === 'premium') {
    return <Badge variant="success">Premium</Badge>;
  }
  if (tier === 'pro') {
    return <Badge variant="outline">Pro</Badge>;
  }
  return <Badge variant="outline">Free</Badge>;
}
