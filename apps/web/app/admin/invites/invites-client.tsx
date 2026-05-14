'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format/date';
import { generateInviteCodeAction, revokeInviteCodeAction } from './actions';

interface CodeRow {
  id: string;
  code: string;
  isMultiUse: boolean;
  maxUses: number;
  useCount: number;
  expiresAtIso: string;
  revokedAtIso: string | null;
  createdAtIso: string;
  statusLabel: 'active' | 'expired' | 'revoked' | 'fully_used';
}

interface Props {
  codes: CodeRow[];
}

export function InvitesClient({ codes: initial }: Props) {
  const [codes, setCodes] = React.useState(initial);
  const [count, setCount] = React.useState(1);
  const [isMultiUse, setIsMultiUse] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justGenerated, setJustGenerated] = React.useState<string[]>([]);
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null);

  async function onGenerate() {
    setGenerating(true);
    setError(null);
    const result = await generateInviteCodeAction({ count, isMultiUse });
    setGenerating(false);
    if (!result.ok || !result.codes) {
      setError(result.errorMessage ?? 'Failed to generate.');
      return;
    }
    setJustGenerated(result.codes);
    // Optimistic prepend — page revalidates server-side so the real
    // rows show up on next render too.
    const now = new Date().toISOString();
    setCodes((prev) => [
      ...result.codes!.map((code) => ({
        id: code,
        code,
        isMultiUse,
        maxUses: isMultiUse ? 50 : 1,
        useCount: 0,
        expiresAtIso: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        revokedAtIso: null,
        createdAtIso: now,
        statusLabel: 'active' as const,
      })),
      ...prev,
    ]);
  }

  async function onRevoke(id: string) {
    if (!confirm('Revoke this code? Anyone holding it can no longer sign up.')) return;
    const result = await revokeInviteCodeAction(id);
    if (result.ok) {
      setCodes((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, revokedAtIso: new Date().toISOString(), statusLabel: 'revoked' as const }
            : c,
        ),
      );
    }
  }

  async function onCopy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 1500);
    } catch {
      // Older browsers: fall back to selection.
    }
  }

  return (
    <>
      <section className="bg-card mb-6 rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-medium">Generate</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="count">Count</Label>
            <Input
              id="count"
              type="number"
              min={1}
              max={25}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
              className="w-24"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isMultiUse}
              onChange={(e) => setIsMultiUse(e.target.checked)}
              className="h-4 w-4"
            />
            Multi-use (50 uses)
          </label>
          <Button type="button" onClick={onGenerate} disabled={generating}>
            {generating ? 'Generating…' : 'Generate'}
          </Button>
        </div>
        {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
        {justGenerated.length > 0 && (
          <div className="bg-muted mt-3 rounded-md p-3">
            <p className="text-muted-foreground text-xs">Just generated:</p>
            <p className="font-mono text-sm">{justGenerated.join(' · ')}</p>
          </div>
        )}
      </section>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Uses</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {codes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-6 text-center text-sm">
                  No invite codes yet — click Generate above.
                </TableCell>
              </TableRow>
            ) : (
              codes.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => onCopy(c.code)}
                      className="font-mono text-sm hover:underline"
                      title="Click to copy"
                    >
                      {c.code}
                      {copiedCode === c.code && (
                        <span className="text-muted-foreground ml-2 text-xs">copied!</span>
                      )}
                    </button>
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={c.statusLabel} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {c.useCount} / {c.maxUses}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDateTime(new Date(c.createdAtIso))}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDateTime(new Date(c.expiresAtIso))}
                  </TableCell>
                  <TableCell>
                    {c.statusLabel === 'active' && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRevoke(c.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function StatusBadge({ label }: { label: CodeRow['statusLabel'] }) {
  const palette: Record<CodeRow['statusLabel'], string> = {
    active: 'bg-green-500/10 text-green-700 border border-green-500/40',
    expired: 'bg-muted text-muted-foreground',
    revoked: 'bg-destructive/10 text-destructive border border-destructive/40',
    fully_used: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${palette[label]}`}>
      {label.replace(/_/g, ' ')}
    </span>
  );
}
