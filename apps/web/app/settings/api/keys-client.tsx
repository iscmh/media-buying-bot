'use client';

import * as React from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createApiKeyAction, revokeApiKeyAction, type ApiKeyListRow } from './actions';

interface Props {
  initial: ApiKeyListRow[];
}

/**
 * Polish-25.10 Commit 59: API-key manager UI. Two dialogs:
 *   1. Create — name input → shows plaintext once with copy button
 *   2. Revoke — plain confirm + call server action
 *
 * The plaintext is stored in React state ONLY inside the modal's
 * lifetime. Closing the modal drops it — mirrors OpenAI's UX.
 */
export function ApiKeysClient({ initial }: Props) {
  const [keys, setKeys] = React.useState<ApiKeyListRow[]>(initial);
  const [creating, setCreating] = React.useState(false);
  const [newKeyPlaintext, setNewKeyPlaintext] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  async function handleCreate() {
    setError(null);
    setBusy(true);
    const result = await createApiKeyAction({ name });
    setBusy(false);
    if (!result.ok || !result.plaintext || !result.row) {
      setError(result.errorMessage ?? 'Could not create key.');
      return;
    }
    setNewKeyPlaintext(result.plaintext);
    setKeys((prev) => [
      {
        id: result.row!.id,
        name: result.row!.name,
        keyPrefix: result.row!.keyPrefix,
        createdAt: result.row!.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      },
      ...prev,
    ]);
    setName('');
  }

  async function handleRevoke(keyId: string, keyName: string) {
    if (!confirm(`Revoke API key "${keyName}"? This cannot be undone.`)) return;
    const result = await revokeApiKeyAction({ keyId });
    if (!result.ok) {
      alert(result.errorMessage ?? 'Could not revoke key.');
      return;
    }
    setKeys((prev) =>
      prev.map((k) => (k.id === keyId ? { ...k, revokedAt: new Date().toISOString() } : k)),
    );
  }

  async function copyToClipboard() {
    if (!newKeyPlaintext) return;
    try {
      await navigator.clipboard.writeText(newKeyPlaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — the input is still selectable
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="accent"
          size="sm"
          onClick={() => setCreating(true)}
          disabled={creating}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          Create key
        </Button>
      </div>

      {keys.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No API keys yet.</CardTitle>
          </CardHeader>
          <CardContent className="text-fg-muted text-sm">
            Create a key to start driving the pipeline from your own scripts.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-2">
          {keys.map((k) => (
            <li key={k.id}>
              <Card>
                <CardContent className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-fg text-sm font-medium">{k.name}</span>
                      {k.revokedAt && (
                        <span className="text-error text-[10px] uppercase tracking-wide">
                          revoked
                        </span>
                      )}
                    </div>
                    <div className="text-fg-muted mt-1 font-mono text-xs">
                      sk_live_{k.keyPrefix}…
                    </div>
                    <div className="text-fg-muted mt-1 text-xs">
                      Created {fmtDate(k.createdAt)}
                      {k.lastUsedAt ? ` · Last used ${fmtDate(k.lastUsedAt)}` : ' · Never used'}
                    </div>
                  </div>
                  {!k.revokedAt && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(k.id, k.name)}
                      aria-label={`Revoke ${k.name}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setNewKeyPlaintext(null);
            setName('');
            setError(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{newKeyPlaintext ? 'Save this key now' : 'Create API key'}</DialogTitle>
            <DialogDescription>
              {newKeyPlaintext
                ? "This is the only time you'll see the full key. Copy it and store it somewhere safe."
                : 'Give it a memorable name (e.g. "prod-scripts", "laptop", "vercel-cron").'}
            </DialogDescription>
          </DialogHeader>

          {newKeyPlaintext ? (
            <div className="space-y-3">
              <div className="bg-panel border-border overflow-x-auto rounded border p-3 font-mono text-xs">
                {newKeyPlaintext}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="accent" size="sm" onClick={copyToClipboard}>
                  <Copy className="mr-1 h-4 w-4" aria-hidden />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCreating(false);
                    setNewKeyPlaintext(null);
                    setName('');
                    setCopied(false);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="apikey-name">Name</Label>
                <Input
                  id="apikey-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="prod-scripts"
                  maxLength={80}
                  autoFocus
                />
              </div>
              {error && <div className="text-error text-sm">{error}</div>}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="accent"
                  size="sm"
                  onClick={handleCreate}
                  disabled={busy || name.trim().length === 0}
                >
                  {busy ? 'Creating…' : 'Create key'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCreating(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toISOString().slice(0, 10);
}
