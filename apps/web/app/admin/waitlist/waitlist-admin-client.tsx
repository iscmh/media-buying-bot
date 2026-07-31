'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format/date';
import { approveWaitlistEntryAction } from './actions';

interface UnapprovedRow {
  id: string;
  email: string;
  name: string | null;
  source: string | null;
  message: string | null;
  createdAtIso: string;
}

interface ApprovedRow {
  id: string;
  email: string;
  name: string | null;
  source: string | null;
  createdAtIso: string;
  approvedAtIso: string;
}

interface Props {
  unapproved: UnapprovedRow[];
  approved: ApprovedRow[];
}

export function WaitlistAdminClient({ unapproved: initial, approved }: Props) {
  const [unapproved, setUnapproved] = React.useState(initial);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [showApproved, setShowApproved] = React.useState(false);

  async function onApprove(id: string) {
    setPendingId(id);
    const result = await approveWaitlistEntryAction(id);
    setPendingId(null);
    if (!result.ok) {
      setToast(`Error: ${result.errorMessage ?? 'Approval failed.'}`);
      return;
    }
    setUnapproved((prev) => prev.filter((e) => e.id !== id));
    const where = result.emailStubbed
      ? '(stub mode - check server logs for the email body)'
      : result.emailSent
        ? 'email sent'
        : 'but email send failed';
    setToast(`Approved. Code ${result.code} - ${where}.`);
    // Auto-clear toast after a few seconds.
    setTimeout(() => setToast(null), 6000);
  }

  return (
    <>
      {toast && <div className="bg-card mb-4 rounded-md border p-3 text-sm">{toast}</div>}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Awaiting approval ({unapproved.length})</h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {unapproved.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-6 text-center text-sm">
                    Nobody waiting.
                  </TableCell>
                </TableRow>
              ) : (
                unapproved.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-sm">{e.email}</TableCell>
                    <TableCell className="text-xs">{e.name ?? '-'}</TableCell>
                    <TableCell className="text-xs">{e.source ?? '-'}</TableCell>
                    <TableCell className="max-w-[24ch] text-xs">
                      {e.message ? <span title={e.message}>{e.message}</span> : '-'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(new Date(e.createdAtIso))}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onApprove(e.id)}
                        disabled={pendingId === e.id}
                      >
                        {pendingId === e.id ? 'Approving…' : 'Approve'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <button
          type="button"
          onClick={() => setShowApproved((v) => !v)}
          className="text-muted-foreground hover:text-foreground mb-2 text-sm underline underline-offset-4"
        >
          {showApproved ? 'Hide' : 'Show'} already approved ({approved.length})
        </button>
        {showApproved && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Approved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {approved.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-muted-foreground py-6 text-center text-sm"
                    >
                      None approved yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  approved.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-sm">{e.email}</TableCell>
                      <TableCell className="text-xs">{e.name ?? '-'}</TableCell>
                      <TableCell className="text-xs">{e.source ?? '-'}</TableCell>
                      <TableCell className="text-xs">
                        {formatDateTime(new Date(e.createdAtIso))}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDateTime(new Date(e.approvedAtIso))}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}
