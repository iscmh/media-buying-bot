'use client';

import * as React from 'react';
import { Check, X } from 'lucide-react';
import { formatDateTime } from '@/lib/format/date';
import { Button } from '@/components/ui/button';
import { bulkDecideJobAction, decideVariantAction } from './actions';

interface Variant {
  id: string;
  fileUrl: string;
  aspectRatio: string;
  status: string;
  createdAtIso: string;
}

interface Props {
  jobId: string;
  conceptType: 'static' | 'ugc';
  variants: Variant[];
}

export function JobReviewClient({ jobId, conceptType, variants: initial }: Props) {
  // Optimistic local state. Server action triggers revalidatePath, but
  // optimistic updates make individual approvals feel instant.
  const [variants, setVariants] = React.useState<Variant[]>(initial);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [bulkPending, setBulkPending] = React.useState<'approved' | 'rejected' | null>(null);

  const total = variants.length;
  const approvedCount = variants.filter((v) => v.status === 'approved').length;
  const rejectedCount = variants.filter((v) => v.status === 'rejected').length;
  const undecidedCount = total - approvedCount - rejectedCount;
  const allDecided = undecidedCount === 0;

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setPendingId(id);
    setVariants((prev) => prev.map((v) => (v.id === id ? { ...v, status: decision } : v)));
    const result = await decideVariantAction(id, decision);
    setPendingId(null);
    if (!result.ok) {
      // Revert on failure.
      setVariants(initial);
    }
  }

  async function bulk(decision: 'approved' | 'rejected') {
    setBulkPending(decision);
    setVariants((prev) =>
      prev.map((v) => (v.status === 'ready_for_review' ? { ...v, status: decision } : v)),
    );
    const result = await bulkDecideJobAction(jobId, decision);
    setBulkPending(null);
    if (!result.ok) {
      setVariants(initial);
    }
  }

  return (
    <>
      <div className="bg-card mb-6 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm">
          <strong>{approvedCount} approved</strong>
          {' · '}
          <span className="text-destructive">{rejectedCount} rejected</span>
          {' · '}
          <span className="text-muted-foreground">{undecidedCount} pending</span>
          {' / '}
          {total} total
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => bulk('approved')}
            disabled={!!bulkPending || allDecided}
          >
            {bulkPending === 'approved' ? 'Approving…' : 'Approve all pending'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => bulk('rejected')}
            disabled={!!bulkPending || allDecided}
            className="text-destructive"
          >
            {bulkPending === 'rejected' ? 'Rejecting…' : 'Reject all pending'}
          </Button>
        </div>
      </div>

      {allDecided && approvedCount > 0 && (
        <div className="mb-6 rounded-lg border border-green-500/40 bg-green-500/5 p-4 text-sm">
          <strong>Done — ready for launch.</strong>{' '}
          <span className="text-muted-foreground">
            {approvedCount} approved variants are sitting in `approved` status. Phase 4 (Meta auto-
            launch) will pick them up.
          </span>
        </div>
      )}

      <div
        className={
          conceptType === 'static'
            ? 'grid gap-4 sm:grid-cols-2 md:grid-cols-3'
            : 'grid gap-4 sm:grid-cols-2'
        }
      >
        {variants.map((v) => (
          <VariantCard
            key={v.id}
            variant={v}
            isPending={pendingId === v.id}
            conceptType={conceptType}
            onApprove={() => decide(v.id, 'approved')}
            onReject={() => decide(v.id, 'rejected')}
          />
        ))}
      </div>
    </>
  );
}

interface VariantCardProps {
  variant: Variant;
  isPending: boolean;
  conceptType: 'static' | 'ugc';
  onApprove: () => void;
  onReject: () => void;
}

function VariantCard({ variant, isPending, conceptType, onApprove, onReject }: VariantCardProps) {
  const isApproved = variant.status === 'approved';
  const isRejected = variant.status === 'rejected';

  return (
    <article
      className={
        'bg-card flex flex-col overflow-hidden rounded-lg border transition-opacity ' +
        (isRejected ? 'opacity-50' : '')
      }
    >
      <div className="bg-muted aspect-square w-full">
        {conceptType === 'static' ? (
          // Plain img — Phase 3a uses placehold.co (external) and Phase 3b
          // will use Supabase signed URLs that rotate. next/image's optimizer
          // doesn't help either case.
          <img
            src={variant.fileUrl}
            alt="Generated variant"
            className="h-full w-full object-cover"
          />
        ) : (
          <video
            src={variant.fileUrl}
            controls
            className="h-full w-full object-cover"
            preload="metadata"
          />
        )}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <p className="text-muted-foreground text-xs">
          {variant.aspectRatio} · {formatDateTime(new Date(variant.createdAtIso))}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={isApproved ? 'default' : 'outline'}
            onClick={onApprove}
            disabled={isPending}
            className="flex-1"
          >
            <Check className="mr-1 h-4 w-4" />
            {isApproved ? 'Approved' : 'Approve'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={isRejected ? 'destructive' : 'outline'}
            onClick={onReject}
            disabled={isPending}
            className="flex-1"
          >
            <X className="mr-1 h-4 w-4" />
            {isRejected ? 'Rejected' : 'Reject'}
          </Button>
        </div>
      </div>
    </article>
  );
}
