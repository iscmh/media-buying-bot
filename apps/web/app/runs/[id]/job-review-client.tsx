'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, Rocket, X } from 'lucide-react';
import { checkBudgetMeetsMetaMinimum } from '@mbb/shared';
import { formatDateTime } from '@/lib/format/date';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  acknowledgeLaunchAction,
  acknowledgeLiveLaunchAction,
  bulkDecideJobAction,
  decideVariantAction,
  launchApprovedAction,
  refreshMetaPagesAction,
} from './actions';

interface Variant {
  id: string;
  fileUrl: string;
  aspectRatio: string;
  status: string;
  createdAtIso: string;
  headline: string | null;
  primaryText: string | null;
  description: string | null;
  /**
   * Polish-9.12: Kling multi-clip jobs emit one composite row
   * (isClipPart=false, format ending in '_final_composite') plus N
   * source-clip rows (isClipPart=true). The UI surfaces the composite
   * as the primary deliverable and collapses source clips. Optional
   * for backwards compat with non-Kling jobs.
   */
  isClipPart?: boolean;
  clipIndex?: number | null;
  format?: string;
}

export interface LaunchSnapshot {
  // Phase 4a launch ack (any mode).
  acknowledged: boolean;
  // Phase 4b live-launch ack (triple-confirm).
  liveAcknowledged: boolean;
  liveLaunchCount: number;
  firstLaunchCapUsd: number;
  perAdBudgetUsd: number;
  optimizationGoal: string;
  placementType: string;
  defaultPageId: string | null;
  defaultOfferUrl: string;
  defaultCountries: string[];
  defaultAgeMin: number;
  defaultAgeMax: number;
  metaPages: Array<{ pageId: string; pageName: string }>;
  /** Polish-3.5: per-account currency for the budget preview. */
  accountCurrency: string;
  /** Per-account override for Meta's minimum daily budget (minor units). */
  minDailyBudgetMinor: number | null;
  committedTodayUsd: number;
  capUsd: number;
  remainingUsd: number;
}

interface Props {
  jobId: string;
  conceptType: 'static' | 'ugc';
  variants: Variant[];
  launchSnapshot: LaunchSnapshot;
}

export function JobReviewClient({ jobId, conceptType, variants: initial, launchSnapshot }: Props) {
  const router = useRouter();
  // Optimistic local state. Server action triggers revalidatePath, but
  // optimistic updates make individual approvals feel instant.
  const [variants, setVariants] = React.useState<Variant[]>(initial);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [bulkPending, setBulkPending] = React.useState<'approved' | 'rejected' | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(launchSnapshot.acknowledged);
  const [liveAcknowledged, setLiveAcknowledged] = React.useState(launchSnapshot.liveAcknowledged);
  const [showLaunchDialog, setShowLaunchDialog] = React.useState(false);
  const [launchPending, setLaunchPending] = React.useState(false);
  const [launchError, setLaunchError] = React.useState<string | null>(null);

  // Polish-3.5: launch is always live. The mock back door survives in
  // the server action for tests / CLI; the UI never reaches it.
  const mode = 'live' as const;
  const [pageId, setPageId] = React.useState<string>(launchSnapshot.defaultPageId ?? '');
  const [offerUrl, setOfferUrl] = React.useState(launchSnapshot.defaultOfferUrl);
  const [countries, setCountries] = React.useState<string[]>(launchSnapshot.defaultCountries);
  const [ageMin, setAgeMin] = React.useState(launchSnapshot.defaultAgeMin);
  const [ageMax, setAgeMax] = React.useState(launchSnapshot.defaultAgeMax);
  const [pages, setPages] = React.useState(launchSnapshot.metaPages);
  const [pagesRefreshing, setPagesRefreshing] = React.useState(false);
  const [pagesError, setPagesError] = React.useState<string | null>(null);
  const [showCustomizeTargeting, setShowCustomizeTargeting] = React.useState(false);
  const [showTripleAck, setShowTripleAck] = React.useState(false);
  const [ack1, setAck1] = React.useState(false);
  const [ack2, setAck2] = React.useState(false);
  const [ack3, setAck3] = React.useState(false);
  const [tripleAckPending, setTripleAckPending] = React.useState(false);
  const isFirstLiveLaunch = launchSnapshot.liveLaunchCount === 0;

  const total = variants.length;
  const approvedCount = variants.filter((v) => v.status === 'approved').length;
  const rejectedCount = variants.filter((v) => v.status === 'rejected').length;
  const launchedCount = variants.filter(
    (v) => v.status === 'launched' || v.status === 'launch_failed',
  ).length;
  const undecidedCount = total - approvedCount - rejectedCount - launchedCount;
  const allDecided = undecidedCount === 0;
  const launchableCount = variants.filter((v) => v.status === 'approved').length;
  const totalBudgetIfLaunched = launchableCount * launchSnapshot.perAdBudgetUsd;
  const exceedsCap = totalBudgetIfLaunched > launchSnapshot.remainingUsd;
  const exceedsFirstLaunchCap =
    isFirstLiveLaunch && totalBudgetIfLaunched > launchSnapshot.firstLaunchCapUsd;

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

  function onLaunchClick() {
    setLaunchError(null);
    if (!liveAcknowledged) {
      // First-ever live launch — block the dialog behind the triple-ack
      // checklist. Resetting the checkboxes here guarantees fresh
      // consent if the user dismissed it earlier.
      setAck1(false);
      setAck2(false);
      setAck3(false);
      setShowTripleAck(true);
      return;
    }
    setShowLaunchDialog(true);
  }

  async function confirmTripleAck() {
    if (!(ack1 && ack2 && ack3)) return;
    setTripleAckPending(true);
    try {
      const result = await acknowledgeLiveLaunchAction();
      if (!result.ok) {
        setLaunchError(result.errorMessage ?? 'Could not record acknowledgment.');
        return;
      }
      setLiveAcknowledged(true);
      setShowTripleAck(false);
      setShowLaunchDialog(true);
    } finally {
      setTripleAckPending(false);
    }
  }

  async function refreshPages() {
    setPagesError(null);
    setPagesRefreshing(true);
    try {
      const result = await refreshMetaPagesAction();
      if (!result.ok) {
        setPagesError(result.errorMessage ?? 'Could not refresh pages.');
      }
      setPages(result.pages);
      if (!pageId && result.pages.length > 0) {
        setPageId(result.pages[0]!.pageId);
      }
    } finally {
      setPagesRefreshing(false);
    }
  }

  async function confirmLaunch() {
    setLaunchError(null);
    setLaunchPending(true);
    try {
      if (!acknowledged) {
        const ack = await acknowledgeLaunchAction();
        if (!ack.ok) {
          setLaunchError(ack.errorMessage ?? 'Could not record acknowledgment.');
          return;
        }
        setAcknowledged(true);
      }
      const result = await launchApprovedAction({
        jobId,
        mode,
        pageId: pageId || undefined,
        offerUrl: offerUrl || undefined,
        targetingCountries: countries,
        ageMin,
        ageMax,
      });
      if (!result.ok) {
        setLaunchError(result.errorMessage ?? 'Launch failed.');
        return;
      }
      setShowLaunchDialog(false);
      router.push('/launched');
    } finally {
      setLaunchPending(false);
    }
  }

  return (
    <>
      <div className="bg-card mb-6 flex flex-col gap-3 rounded-sm border p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm">
          <strong>{approvedCount} approved</strong>
          {' · '}
          <span className="text-destructive">{rejectedCount} rejected</span>
          {' · '}
          <span className="text-muted-foreground">{undecidedCount} pending</span>
          {' / '}
          {total} total
        </p>
        <div className="flex flex-wrap gap-2">
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
          <Button
            type="button"
            size="sm"
            onClick={onLaunchClick}
            disabled={launchableCount === 0 || launchPending}
            title={
              launchableCount === 0
                ? 'Approve at least one variant first.'
                : `Launch ${launchableCount} approved variant${launchableCount === 1 ? '' : 's'}.`
            }
          >
            <Rocket className="mr-1 h-4 w-4" />
            Launch approved ({launchableCount})
          </Button>
        </div>
      </div>

      {allDecided && approvedCount > 0 && (
        <div className="border-[color:var(--accent-positive)]/30 bg-[color:var(--accent-positive)]/10 mb-6 rounded-sm border p-4 text-sm">
          <strong>Done — ready for launch.</strong>{' '}
          <span className="text-muted-foreground">
            {approvedCount} approved variants are sitting in `approved` status. Phase 4 (Meta auto-
            launch) will pick them up.
          </span>
        </div>
      )}

      {/* Polish-9.12: primary deliverables (composite + non-clip
          variants) render first. Source clips from Kling multi-clip
          jobs are tucked into a collapsible section below. */}
      <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
        {variants
          .filter((v) => !v.isClipPart)
          .map((v) => (
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
      {variants.some((v) => v.isClipPart) && (
        <details className="border-border bg-bg-elevated mt-6 rounded-sm border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Source clips ({variants.filter((v) => v.isClipPart).length}) — transparency / individual
            download
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
            {variants
              .filter((v) => v.isClipPart)
              .map((v) => (
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
        </details>
      )}
      {conceptType === 'static' && variants.length > 0 && (
        <p className="text-muted-foreground mt-4 text-center text-xs">
          Click any image to view full size and download.
        </p>
      )}

      <Dialog open={showLaunchDialog} onOpenChange={setShowLaunchDialog}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Launch ads to Meta</DialogTitle>
            <DialogDescription>
              {launchableCount} approved variant{launchableCount === 1 ? '' : 's'} will be created
              as <strong>PAUSED</strong> ads in your Meta account. You activate them manually in Ads
              Manager.
            </DialogDescription>
          </DialogHeader>

          <p className="text-fg-muted text-xs">
            Ads are created PAUSED. They do not spend money until you activate them in Meta Ads
            Manager.
          </p>

          {/* Launch settings */}
          <>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="pageId">Facebook Page</Label>
                <button
                  type="button"
                  onClick={refreshPages}
                  disabled={pagesRefreshing}
                  className="text-primary text-xs underline-offset-4 hover:underline disabled:opacity-50"
                >
                  {pagesRefreshing ? 'Refreshing…' : 'Refresh pages'}
                </button>
              </div>
              {pages.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No pages cached yet. Click &quot;Refresh pages&quot; to fetch from Meta.
                </p>
              ) : (
                <select
                  id="pageId"
                  value={pageId}
                  onChange={(e) => setPageId(e.target.value)}
                  className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                >
                  <option value="">— Select a page —</option>
                  {pages.map((p) => (
                    <option key={p.pageId} value={p.pageId}>
                      {p.pageName} ({p.pageId})
                    </option>
                  ))}
                </select>
              )}
              {pagesError && <p className="text-destructive text-xs">{pagesError}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="offerUrl">Offer URL</Label>
              <Input
                id="offerUrl"
                type="url"
                value={offerUrl}
                onChange={(e) => setOfferUrl(e.target.value)}
                placeholder="https://your-offer.example/landing"
              />
              <p className="text-muted-foreground text-xs">
                Where clicks send users. Pre-filled from the concept&apos;s offer URL.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Targeting</Label>
                <button
                  type="button"
                  onClick={() => setShowCustomizeTargeting((v) => !v)}
                  className="text-primary text-xs underline-offset-4 hover:underline"
                >
                  {showCustomizeTargeting ? 'Hide' : 'Customize'}
                </button>
              </div>
              <p className="text-muted-foreground text-xs">
                {countries.join(', ')} · Age {ageMin}–{ageMax} · {launchSnapshot.optimizationGoal} ·{' '}
                {launchSnapshot.placementType}
              </p>
              {showCustomizeTargeting && (
                <div className="bg-card space-y-3 rounded-md border p-3">
                  <div>
                    <Label className="text-xs">Countries</Label>
                    <Input
                      type="text"
                      value={countries.join(', ')}
                      onChange={(e) =>
                        setCountries(
                          e.target.value
                            .split(',')
                            .map((c) => c.trim().toUpperCase())
                            .filter(Boolean),
                        )
                      }
                      placeholder="US, CA, GB"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Min age</Label>
                      <Input
                        type="number"
                        min={13}
                        max={65}
                        value={ageMin}
                        onChange={(e) => setAgeMin(Number(e.target.value) || 13)}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Max age</Label>
                      <Input
                        type="number"
                        min={13}
                        max={65}
                        value={ageMax}
                        onChange={(e) => setAgeMax(Number(e.target.value) || 65)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>

          {/* Budget + cap summary */}
          <div className="bg-bg-elevated space-y-1 rounded-md border p-3 text-sm">
            <p>
              Variants to launch: <strong>{launchableCount}</strong>
            </p>
            <p>
              Per-ad daily budget: <strong>${launchSnapshot.perAdBudgetUsd.toFixed(2)}</strong>
            </p>
            {/* Polish-3.5: show the budget in the ad account's currency
                so non-USD accounts can see exactly what Meta receives. */}
            {launchSnapshot.accountCurrency !== 'USD' && (
              <BudgetPreview
                usdAmount={launchSnapshot.perAdBudgetUsd}
                currency={launchSnapshot.accountCurrency}
                connectionMin={launchSnapshot.minDailyBudgetMinor}
              />
            )}
            <p>
              Total daily exposure: <strong>${totalBudgetIfLaunched.toFixed(2)}</strong>
            </p>
            {isFirstLiveLaunch && (
              <p className="text-fg-muted text-xs">
                First live launch — capped at ${launchSnapshot.firstLaunchCapUsd.toFixed(2)} total
                daily exposure.
              </p>
            )}
            <hr className="my-2" />
            <p className="text-xs">
              Daily launch cap: <strong>${launchSnapshot.capUsd.toFixed(2)}</strong> · committed
              today <strong>${launchSnapshot.committedTodayUsd.toFixed(2)}</strong> · remaining{' '}
              <strong>${launchSnapshot.remainingUsd.toFixed(2)}</strong>
            </p>
            {exceedsCap && (
              <p className="text-destructive text-xs">
                This launch would exceed your remaining daily cap. Reduce approved variants, raise
                the cap in Settings, or wait until tomorrow.
              </p>
            )}
            {exceedsFirstLaunchCap && (
              <p className="text-destructive text-xs">
                First live launch cannot exceed ${launchSnapshot.firstLaunchCapUsd.toFixed(2)} total
                daily exposure. Reduce variants or lower per-ad budget in Settings.
              </p>
            )}
          </div>

          {launchError && (
            <p className="text-destructive text-sm" role="alert">
              {launchError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowLaunchDialog(false)}
              disabled={launchPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirmLaunch}
              disabled={
                launchPending ||
                exceedsCap ||
                exceedsFirstLaunchCap ||
                !pageId ||
                !offerUrl ||
                countries.length === 0
              }
            >
              {launchPending ? 'Launching…' : 'Launch (paused in Meta — activate manually)'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Phase 4b triple-confirm dialog. Required once per user before
          any live launch. */}
      <Dialog open={showTripleAck} onOpenChange={setShowTripleAck}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>First-time live launch — read carefully</DialogTitle>
            <DialogDescription>
              Live launches push real ads to your Meta ad account. They are created PAUSED, so no
              money moves until you activate them. Still — confirm you understand each statement
              below before continuing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={ack1}
                onChange={(e) => setAck1(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>I have funds available in my Meta ad account.</span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={ack2}
                onChange={(e) => setAck2(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                I understand each ad will spend real money up to its daily budget once activated.
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={ack3}
                onChange={(e) => setAck3(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                I will manually activate ads in Meta Ads Manager — they always start PAUSED.
              </span>
            </label>
          </div>
          <p className="text-muted-foreground text-xs">
            Your first live launch is hard-capped at ${launchSnapshot.firstLaunchCapUsd.toFixed(2)}{' '}
            total daily exposure. Subsequent launches use your daily launch cap from Settings.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowTripleAck(false)}
              disabled={tripleAckPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirmTripleAck}
              disabled={!(ack1 && ack2 && ack3) || tripleAckPending}
            >
              {tripleAckPending ? 'Saving…' : 'Continue to launch'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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

/**
 * Polish-3.5: live USD→account-currency preview for the launch dialog.
 * Re-runs checkBudgetMeetsMetaMinimum so the user sees both the conversion
 * AND any "below Meta minimum" reject reason inline.
 */
function BudgetPreview({
  usdAmount,
  currency,
  connectionMin,
}: {
  usdAmount: number;
  currency: string;
  connectionMin: number | null;
}) {
  const check = checkBudgetMeetsMetaMinimum({
    usdAmount,
    currency,
    connectionMin: connectionMin ?? null,
  });
  if (check.ok) {
    return (
      <p className="text-fg-muted text-xs">
        Account currency: <strong>{currency}</strong> · sent to Meta as{' '}
        <span className="font-mono">
          {check.major.toFixed(2)} {currency} ({check.minor} minor)
        </span>
      </p>
    );
  }
  return <p className="text-xs text-[color:var(--destructive-color)]">{check.reason}</p>;
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
        'bg-card flex flex-col overflow-hidden rounded-sm border transition-opacity ' +
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
