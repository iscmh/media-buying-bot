'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { approveApplicationAction, rejectApplicationAction } from './actions';

interface AppRow {
  id: string;
  email: string;
  name: string | null;
  agencyName: string | null;
  monthlyAdSpendUsd: string | null;
  verticals: string | null;
  whyApply: string | null;
  heardFrom: string | null;
  status: string;
  whopCheckoutUrl: string | null;
  rejectedReason: string | null;
  createdAtLabel: string;
  approvedAtLabel: string | null;
  paidAtLabel: string | null;
}

interface Props {
  pending: AppRow[];
  processed: AppRow[];
}

export function ApplicationsClient({ pending: initialPending, processed }: Props) {
  const [pending, setPending] = React.useState(initialPending);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [approveDialogId, setApproveDialogId] = React.useState<string | null>(null);
  const [rejectDialogId, setRejectDialogId] = React.useState<string | null>(null);
  const [tier, setTier] = React.useState<'monthly' | 'annual' | 'lifetime'>('monthly');
  const [rejectReason, setRejectReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const [showProcessed, setShowProcessed] = React.useState(false);

  async function onApprove(applicationId: string) {
    setBusy(true);
    const result = await approveApplicationAction({ applicationId, tier });
    setBusy(false);
    setApproveDialogId(null);
    if (!result.ok) {
      setToast(`Error: ${result.errorMessage ?? 'Approval failed.'}`);
      return;
    }
    setPending((prev) => prev.filter((a) => a.id !== applicationId));
    const emailState = result.emailStubbed
      ? '(email stubbed — check server logs)'
      : result.emailSent
        ? 'email sent'
        : 'email FAILED';
    setToast(`Approved. Code ${result.inviteCode} · ${emailState}.`);
    setTimeout(() => setToast(null), 8000);
  }

  async function onReject(applicationId: string) {
    setBusy(true);
    const result = await rejectApplicationAction({
      applicationId,
      reason: rejectReason || undefined,
    });
    setBusy(false);
    setRejectDialogId(null);
    setRejectReason('');
    if (!result.ok) {
      setToast(`Error: ${result.errorMessage ?? 'Rejection failed.'}`);
      return;
    }
    setPending((prev) => prev.filter((a) => a.id !== applicationId));
    setToast('Rejected.');
    setTimeout(() => setToast(null), 3000);
  }

  return (
    <>
      {toast && <div className="bg-card mb-4 rounded-md border p-3 text-sm">{toast}</div>}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Pending ({pending.length})</h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Agency</TableHead>
                <TableHead>Spend</TableHead>
                <TableHead>Verticals</TableHead>
                <TableHead>Applied</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-6 text-center text-sm">
                    No pending applications.
                  </TableCell>
                </TableRow>
              ) : (
                pending.flatMap((a) => {
                  const rows = [
                    <TableRow key={a.id}>
                      <TableCell className="text-sm">{a.email}</TableCell>
                      <TableCell className="text-xs">{a.name ?? '—'}</TableCell>
                      <TableCell className="text-xs">{a.agencyName ?? '—'}</TableCell>
                      <TableCell className="text-xs">{a.monthlyAdSpendUsd ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {a.verticals ? a.verticals.split(',').slice(0, 3).join(', ') : '—'}
                      </TableCell>
                      <TableCell className="text-xs">{a.createdAtLabel}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                          >
                            {expandedId === a.id ? 'Hide' : 'View'}
                          </Button>
                          <Button type="button" size="sm" onClick={() => setApproveDialogId(a.id)}>
                            Approve
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="text-destructive"
                            onClick={() => setRejectDialogId(a.id)}
                          >
                            Reject
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>,
                  ];
                  if (expandedId === a.id) {
                    rows.push(
                      <TableRow key={`${a.id}-expand`}>
                        <TableCell colSpan={7} className="bg-card/50 text-xs">
                          <dl className="space-y-1">
                            <div>
                              <dt className="text-muted-foreground inline">Why apply:</dt>{' '}
                              <dd className="inline whitespace-pre-wrap">{a.whyApply ?? '—'}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground inline">Heard from:</dt>{' '}
                              <dd className="inline">{a.heardFrom ?? '—'}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground inline">All verticals:</dt>{' '}
                              <dd className="inline">{a.verticals ?? '—'}</dd>
                            </div>
                          </dl>
                        </TableCell>
                      </TableRow>,
                    );
                  }
                  return rows;
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <button
          type="button"
          onClick={() => setShowProcessed((v) => !v)}
          className="text-muted-foreground hover:text-foreground mb-2 text-sm underline underline-offset-4"
        >
          {showProcessed ? 'Hide' : 'Show'} processed ({processed.length})
        </button>
        {showProcessed && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Applied</TableHead>
                  <TableHead>Approved</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Checkout URL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {processed.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-sm">{a.email}</TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
                    </TableCell>
                    <TableCell className="text-xs">{a.createdAtLabel}</TableCell>
                    <TableCell className="text-xs">{a.approvedAtLabel ?? '—'}</TableCell>
                    <TableCell className="text-xs">{a.paidAtLabel ?? '—'}</TableCell>
                    <TableCell className="text-xs">
                      {a.whopCheckoutUrl ? (
                        <a
                          href={a.whopCheckoutUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline underline-offset-4"
                        >
                          link
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <Dialog open={!!approveDialogId} onOpenChange={(v) => !v && setApproveDialogId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve application</DialogTitle>
            <DialogDescription>
              Pick a tier. The system generates a Whop checkout link + invite code and emails it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="tier">Tier</Label>
            <select
              id="tier"
              value={tier}
              onChange={(e) => setTier(e.target.value as 'monthly' | 'annual' | 'lifetime')}
              className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            >
              <option value="monthly">Monthly — $499/mo</option>
              <option value="annual">Annual — $2,997/year</option>
              <option value="lifetime">Lifetime — $6,667 once</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setApproveDialogId(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => approveDialogId && onApprove(approveDialogId)}
              disabled={busy}
            >
              {busy ? 'Approving…' : 'Approve + send'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejectDialogId} onOpenChange={(v) => !v && setRejectDialogId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject application</DialogTitle>
            <DialogDescription>
              Optional internal reason — not shown to the applicant.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            placeholder="Optional: why are you rejecting?"
            maxLength={500}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRejectDialogId(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => rejectDialogId && onReject(rejectDialogId)}
              disabled={busy}
            >
              {busy ? 'Rejecting…' : 'Reject'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'paid'
      ? 'default'
      : status === 'approved'
        ? 'secondary'
        : status === 'rejected'
          ? 'destructive'
          : 'outline';
  return (
    <Badge variant={variant as 'default' | 'secondary' | 'destructive' | 'outline'}>{status}</Badge>
  );
}
