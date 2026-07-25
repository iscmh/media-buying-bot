'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, Rocket, X } from 'lucide-react';
import { checkBudgetMeetsMetaMinimum, isValidOfferUrl } from '@mbb/shared';
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
  /**
   * Polish-25.3 Commit 18b-hotfix-2: non-null when the row is a
   * static image (Gemini Nano Banana OR OpenAI gpt-image-2 static
   * ad). Preferred signal for the render branch — a
   * concept.contentType='ugc' picking the static_openai pipeline
   * would otherwise render PNG URLs in a <video> tag and silently
   * blank out.
   */
  imageStoragePath?: string | null;
}

/**
 * Polish-25.3 Commit 18b-hotfix-2: variant-level image predicate.
 * Replaces the old `conceptType === 'static'` branch that silently
 * broke Static-ad pipeline runs when the underlying concept was
 * uploaded as UGC (video). Signals in priority order:
 *   1. imageStoragePath present → definitely an image (worker set it)
 *   2. format starts with 'static_' or 'nano_banana' → static image
 *      pipelines (static_openai_image, static_gemini_image, legacy
 *      nano_banana_static_image)
 *   3. concept-type fallback (last-resort for pre-Commit-18b rows
 *      that predate the format tagging)
 */
function isImageVariant(variant: Variant, conceptType: 'static' | 'ugc'): boolean {
  if (variant.imageStoragePath) return true;
  const f = variant.format ?? '';
  if (f.startsWith('static_') || f.startsWith('nano_banana')) return true;
  return conceptType === 'static';
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

export interface LaunchProblem {
  id: string;
  status: string;
  errorMessage: string | null;
  launchedAtIso: string | null;
}

/**
 * Polish-25.2 Commit 16b: named launch presets. Populated
 * server-side from user_launch_presets via loadPresetsForUser().
 */
export interface LaunchPreset {
  id: string;
  name: string;
  targetingCountries: string[];
  ageMin: number;
  ageMax: number;
  optimizationGoal: string;
  placementType: string;
  perAdDailyBudgetUsd: number;
}

interface Props {
  jobId: string;
  conceptType: 'static' | 'ugc';
  variants: Variant[];
  launchSnapshot: LaunchSnapshot;
  /**
   * Polish-25.2 Commit 13: gate the Launch button visibility on
   * whether the user has an active Meta connection. `false` hides
   * the Launch button + shows an inline nudge with a link to
   * /settings/connections?tab=meta.
   */
  hasMetaConnection: boolean;
  /**
   * Polish-25.2 Commit 15: launched_ads rows for this job with
   * status ∈ (rejected_by_meta, launch_failed). Surface Meta's
   * verbatim error inline so users know what to fix.
   */
  launchProblems: LaunchProblem[];
  /**
   * Polish-25.2 Commit 16b: user's saved launch presets. Empty
   * array hides the preset dropdown in the launch dialog.
   */
  launchPresets: LaunchPreset[];
}

export function JobReviewClient({
  jobId,
  conceptType,
  variants: initial,
  launchSnapshot,
  hasMetaConnection,
  launchProblems,
  launchPresets,
}: Props) {
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
  // Polish-25.2 Commit 15: gate Launch button on OfferUrlSchema.
  // "https//foo.com" passes the HTML `type="url"` check in some
  // browsers but fails Meta's stricter URL parser; catching it here
  // saves a Meta API call + a rejected_by_meta row.
  const offerUrlValid = isValidOfferUrl(offerUrl);
  const [countries, setCountries] = React.useState<string[]>(launchSnapshot.defaultCountries);
  const [ageMin, setAgeMin] = React.useState(launchSnapshot.defaultAgeMin);
  const [ageMax, setAgeMax] = React.useState(launchSnapshot.defaultAgeMax);
  // Polish-25.2 Commit 16b: named preset dropdown. Empty string =
  // "Custom (default)" — inline form is authoritative. Selecting a
  // preset overwrites the inline fields with the preset's values.
  // We DON'T track budget/goal/placement locally on the dialog —
  // those live on launchSnapshot and applying a preset only
  // rewrites the fields the dialog exposes (countries + age range).
  // The rest is documented in the preset chip so operators see
  // what a preset covers.
  const [presetId, setPresetId] = React.useState<string>('');
  function applyPreset(id: string) {
    setPresetId(id);
    if (!id) return;
    const p = launchPresets.find((x) => x.id === id);
    if (!p) return;
    setCountries(p.targetingCountries);
    setAgeMin(p.ageMin);
    setAgeMax(p.ageMax);
    setShowCustomizeTargeting(true);
  }
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
      {/* Polish-25.2 Commit 15: launched-ad rejections banner. Meta's
          verbatim error surfaces here (and stays visible after
          reload) so the user sees the failure without going to
          Telegram or querying SQL. */}
      {launchProblems.length > 0 && (
        <div className="border-[color:var(--accent-negative)]/50 bg-[color:var(--accent-negative)]/5 mb-6 rounded-sm border p-4 text-sm">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <p className="text-fg font-semibold">
                {launchProblems.length === 1
                  ? '1 ad was rejected by Meta.'
                  : `${launchProblems.length} ads were rejected by Meta.`}
              </p>
              <p className="text-fg-muted mt-1 text-xs">
                Fix the error below, then hit <strong>Launch approved</strong> above to try again.
              </p>
            </div>
            <a
              href="/launched"
              className="border-fg/30 hover:bg-bg-surfaceHover shrink-0 rounded-sm border px-2 py-1 text-xs"
            >
              View all
            </a>
          </div>
          <ul className="mt-3 space-y-2">
            {launchProblems.map((p) => (
              <li
                key={p.id}
                className="border-border-subtle bg-bg-inset/40 rounded-sm border p-3 font-mono text-xs leading-snug"
              >
                <div className="text-fg-subtle mb-1 uppercase tracking-wider">
                  {p.status.replace(/_/g, ' ')}
                </div>
                <div className="text-fg whitespace-pre-wrap break-words">
                  {p.errorMessage ?? '(no error message from Meta — check /launched for detail)'}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

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
          {/* Polish-25.2 Commit 13: Launch button only renders when
              Meta is connected. Without a Meta connection the button
              is useless (the launch flow can't complete), so we hide
              it entirely and surface an inline nudge below. */}
          {hasMetaConnection && (
            <Button
              type="button"
              variant="accent"
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
          )}
        </div>
      </div>

      {allDecided && approvedCount > 0 && !hasMetaConnection && (
        // Polish-25.2 Commit 13: Meta-disconnected variant of the
        // "ready for launch" banner. Links directly to the inline
        // Meta connect flow at /settings/connections?tab=meta.
        <div className="border-fg/20 bg-bg-surface mb-6 flex flex-wrap items-center justify-between gap-3 rounded-sm border p-4 text-sm">
          <div>
            <strong>Ready for launch.</strong>{' '}
            <span className="text-muted-foreground">
              {approvedCount} approved variant{approvedCount === 1 ? '' : 's'} waiting on a Meta ad
              account. Connect Meta to push them live.
            </span>
          </div>
          <a
            href="/settings/connections?tab=meta"
            className="border-fg/30 hover:bg-bg-surfaceHover inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium"
          >
            <Rocket className="h-3.5 w-3.5" aria-hidden />
            Connect Meta
          </a>
        </div>
      )}

      {allDecided && approvedCount > 0 && hasMetaConnection && (
        <div className="border-[color:var(--accent-positive)]/30 bg-[color:var(--accent-positive)]/10 mb-6 rounded-sm border p-4 text-sm">
          <strong>Ready for launch.</strong>{' '}
          <span className="text-muted-foreground">
            {approvedCount} approved variant{approvedCount === 1 ? '' : 's'} — hit Launch approved
            above to push them to Meta as paused ads.
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
      {/* Polish-25.3 Commit 18b-hotfix-2: hint now shows whenever
          the job produced ANY image variants (either a static concept
          OR a Static-ad pipeline run on a UGC concept), not only
          when the concept itself is static. */}
      {variants.some((v) => isImageVariant(v, conceptType)) && variants.length > 0 && (
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

          {/* Polish-25.2 Commit 16b: preset dropdown. Only renders
              when the user has ≥1 saved preset. Applies the
              preset's targeting fields to the inline form. */}
          {launchPresets.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="preset">Preset</Label>
              <select
                id="preset"
                value={presetId}
                onChange={(e) => applyPreset(e.target.value)}
                className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
              >
                <option value="">Custom (use defaults below)</option>
                {launchPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="text-fg-muted text-xs">
                Presets fill in countries and age range.{' '}
                <a
                  href="/settings/presets"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Manage presets
                </a>
              </p>
            </div>
          )}

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
                aria-invalid={offerUrl.length > 0 && !offerUrlValid}
              />
              {offerUrl.length > 0 && !offerUrlValid ? (
                <p className="text-destructive text-xs">
                  Enter a full URL starting with <code className="font-mono">http://</code> or{' '}
                  <code className="font-mono">https://</code>. Meta will reject anything shorter and
                  the ad won&apos;t launch.
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Where clicks send users. Pre-filled from the concept&apos;s offer URL.
                </p>
              )}
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
                !offerUrlValid ||
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

  // Polish-25.3 Commit 18b-hotfix-2: variant-level image predicate
  // replaces the old conceptType-only branch. Without this, a
  // Static-ad pipeline run on a UGC-video concept dumped PNG URLs
  // into a <video> tag → silent blank square on the review page
  // (operator report from 18b live-fire test).
  const isImage = isImageVariant(variant, conceptType);

  const downloadFilename = `variant-${variant.id}${isImage ? '.png' : '.mp4'}`;
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
        {isImage ? (
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

      {isImage && (
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
