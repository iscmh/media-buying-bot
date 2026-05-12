'use client';

import * as React from 'react';
import { Check, Download, X } from 'lucide-react';
import { formatDateTime } from '@/lib/format/date';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { bulkDecideJobAction, decideVariantAction } from './actions';

interface Variant {
  id: string;
  fileUrl: string;
  aspectRatio: string;
  status: string;
  createdAtIso: string;
  headline: string | null;
  primaryText: string | null;
  description: string | null;
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

      <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
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
      {conceptType === 'static' && variants.length > 0 && (
        <p className="text-muted-foreground mt-4 text-center text-xs">
          Click any image to view full size and download.
        </p>
      )}
    </>
  );
}

async function downloadVariantImage(fileUrl: string, filename: string) {
  // Cross-origin <a download> is ignored by browsers without
  // Content-Disposition. Fetch as a blob, then trigger a same-origin
  // download via an object URL.
  const res = await fetch(fileUrl);
  if (!res.ok) {
    window.open(fileUrl, '_blank', 'noopener');
    return;
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
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
  const [copyExpanded, setCopyExpanded] = React.useState(false);
  const [expandOpen, setExpandOpen] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);

  const hasCopy = Boolean(variant.headline || variant.primaryText || variant.description);
  const primaryTextNeedsClamp =
    variant.primaryText != null && variant.primaryText.length > 160 && !copyExpanded;

  const downloadFilename = `variant-${variant.id}.png`;
  async function onDownload() {
    setDownloading(true);
    try {
      await downloadVariantImage(variant.fileUrl, downloadFilename);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <article
      className={
        'bg-card flex flex-col overflow-hidden rounded-lg border transition-opacity ' +
        (isRejected ? 'opacity-50' : '')
      }
    >
      <div className="bg-muted aspect-square w-full">
        {conceptType === 'static' ? (
          // Plain img — Phase 3a uses placehold.co (external) and Phase 3c
          // stores Supabase public URLs. next/image's optimizer doesn't
          // help either case.
          <button
            type="button"
            onClick={() => setExpandOpen(true)}
            className="block h-full w-full cursor-pointer"
            aria-label="View full size"
          >
            <img
              src={variant.fileUrl}
              alt={variant.headline ?? 'Generated variant'}
              className="h-full w-full object-cover"
            />
          </button>
        ) : (
          <video
            src={variant.fileUrl}
            controls
            className="h-full w-full object-cover"
            preload="metadata"
          />
        )}
      </div>

      {conceptType === 'static' && (
        <Dialog open={expandOpen} onOpenChange={setExpandOpen}>
          <DialogContent className="max-h-[95vh] max-w-4xl overflow-y-auto p-0 sm:p-0">
            <DialogTitle className="sr-only">
              {variant.headline ?? 'Generated variant'} — full size view
            </DialogTitle>
            <div className="flex flex-col">
              <div className="bg-muted flex items-center justify-center">
                <img
                  src={variant.fileUrl}
                  alt={variant.headline ?? 'Generated variant'}
                  className="max-h-[80vh] w-auto max-w-full object-contain"
                />
              </div>
              <div className="flex flex-col gap-4 p-6">
                {hasCopy && (
                  <div className="flex flex-col gap-2">
                    {variant.headline && (
                      <h2 className="text-xl font-semibold leading-snug">{variant.headline}</h2>
                    )}
                    {variant.primaryText && (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">
                        {variant.primaryText}
                      </p>
                    )}
                    {variant.description && (
                      <p className="text-muted-foreground text-xs leading-snug">
                        {variant.description}
                      </p>
                    )}
                  </div>
                )}
                <p className="text-muted-foreground text-xs">
                  {variant.aspectRatio} · {formatDateTime(new Date(variant.createdAtIso))}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onDownload}
                    disabled={downloading}
                    className="flex-1"
                  >
                    <Download className="mr-1 h-4 w-4" />
                    {downloading ? 'Downloading…' : 'Download image'}
                  </Button>
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
            </div>
          </DialogContent>
        </Dialog>
      )}

      <div className="flex flex-col gap-3 p-4">
        {hasCopy && (
          <div className="flex flex-col gap-1.5">
            {variant.headline && (
              <h3 className="text-base font-semibold leading-snug">{variant.headline}</h3>
            )}
            {variant.primaryText && (
              <p
                className={'text-sm leading-snug ' + (primaryTextNeedsClamp ? 'line-clamp-3' : '')}
              >
                {variant.primaryText}
              </p>
            )}
            {variant.primaryText && variant.primaryText.length > 160 && (
              <button
                type="button"
                onClick={() => setCopyExpanded((v) => !v)}
                className="text-muted-foreground hover:text-foreground self-start text-xs underline"
              >
                {copyExpanded ? 'See less' : 'See more'}
              </button>
            )}
            {variant.description && (
              <p className="text-muted-foreground text-xs leading-snug">{variant.description}</p>
            )}
          </div>
        )}
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
