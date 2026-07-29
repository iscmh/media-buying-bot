import { notFound } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { assertDailyLaunchBudgetCap, getDb, schema } from '@mbb/db';
import {
  FIRST_LIVE_LAUNCH_HARD_CAP_USD,
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  describePipeline,
  pipelineFromString,
  translateGenerationError,
} from '@mbb/shared';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { loadPresetsForUser } from '@/app/settings/presets/actions';
import { JobReviewClient } from './job-review-client';
import { JobTimeline } from './job-timeline';
import { ProcessingTimeoutCard } from './_components/processing-timeout-card';

export const metadata = { title: 'Variant review' };
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function JobReviewPage({ params }: Props) {
  const { id } = await params;
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const job = await db.query.generationJobs.findFirst({
    where: and(eq(schema.generationJobs.id, id), eq(schema.generationJobs.userId, userId)),
  });
  if (!job) notFound();

  const variants = await db.query.generatedCreatives.findMany({
    where: eq(schema.generatedCreatives.generationJobId, id),
    orderBy: asc(schema.generatedCreatives.createdAt),
  });

  // Polish-9.12 + Polish-11: a Kling multi-clip job emits up to three
  // row types — the lip-synced composite (Polish-11 primary
  // deliverable, format ends with '_lipsynced'), the silent stitched
  // composite (Polish-9.12), and N per-clip rows. Sort so the
  // lip-synced row is first, then the silent composite, then clip
  // parts ordered by clipIndex. Non-Kling jobs are unaffected.
  const variantRank = (v: (typeof variants)[number]): number => {
    if (!v.isClipPart && v.format.endsWith('_lipsynced')) return 0;
    if (!v.isClipPart && v.format.endsWith('_final_composite')) return 1;
    if (!v.isClipPart) return 2;
    return 3;
  };
  const sortedVariants = [...variants].sort((a, b) => {
    const ra = variantRank(a);
    const rb = variantRank(b);
    if (ra !== rb) return ra - rb;
    if (a.clipIndex != null && b.clipIndex != null) return a.clipIndex - b.clipIndex;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const conceptIds = job.conceptIds ?? [];
  const concept =
    conceptIds.length > 0
      ? await db.query.concepts.findFirst({
          where: eq(schema.concepts.id, conceptIds[0]!),
          columns: { contentType: true, offerUrl: true },
        })
      : null;
  const conceptType = concept?.contentType ?? 'static';

  // Polish-25.2 Commit 15: surface Meta launch rejections + failures
  // on the run detail page. Before Commit 15, the operator launched a
  // variant, saw a green "1 ad launched" response from the action,
  // and never learned that Meta rejected it — the rejection lived on
  // launched_ads.status + launched_ads.error_message and only
  // surfaced via SQL or /launched.
  const launchedAdsForJob = await db.query.launchedAds.findMany({
    where: and(eq(schema.launchedAds.userId, userId), eq(schema.launchedAds.generationJobId, id)),
    columns: { id: true, status: true, errorMessage: true, launchedAt: true },
    orderBy: asc(schema.launchedAds.launchedAt),
  });
  const launchProblems = launchedAdsForJob.filter(
    (r) => r.status === 'rejected_by_meta' || r.status === 'launch_failed',
  );

  // Phase 4a + 4b launch context: settings, cached pages, cap snapshot,
  // first-live-launch state. Passed into the client so the dialog
  // doesn't need a follow-up fetch on open.
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: {
      launchAcknowledgedAt: true,
      liveLaunchAcknowledgedAt: true,
      liveLaunchCount: true,
      defaultAdDailyBudgetUsd: true,
      defaultOptimizationGoal: true,
      defaultPlacementType: true,
      defaultPageId: true,
      defaultTargetingCountries: true,
      defaultAgeMin: true,
      defaultAgeMax: true,
    },
  });
  const metaPages = await db.query.metaPages.findMany({
    where: eq(schema.metaPages.userId, userId),
    columns: { pageId: true, pageName: true },
  });
  // Polish-3.5: pull the active Meta connection so the launch dialog can
  // surface the account currency + min-budget for the budget preview
  // ("USD $10 → RON 45.50").
  // Polish-25.2 Commit 14: pull businessManagerId + adAccountIds
  // so hasMetaConnection can require the full metadata (not just
  // status='active'). A partially-configured row — token verified
  // but selection never completed — otherwise satisfies the
  // status='active' check while being unusable for launch.
  const metaConn = await db.query.metaConnections.findFirst({
    where: and(
      eq(schema.metaConnections.userId, userId),
      eq(schema.metaConnections.status, 'active'),
    ),
    columns: {
      accountCurrency: true,
      minDailyBudgetMinor: true,
      businessManagerId: true,
      adAccountIds: true,
    },
  });
  const perAdBudget = Math.min(
    Number(settings?.defaultAdDailyBudgetUsd ?? 10),
    PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  );
  const launchCap = await assertDailyLaunchBudgetCap(userId, 0);
  // Polish-25.2 Commit 16b: named launch presets. Passed into the
  // dialog dropdown; empty array → dropdown hidden. Clamp per-ad
  // budget on preset apply too — user might have saved a preset
  // before the platform ceiling dropped.
  const launchPresets = await loadPresetsForUser(userId);
  const launchSnapshot = {
    acknowledged: !!settings?.launchAcknowledgedAt,
    liveAcknowledged: !!settings?.liveLaunchAcknowledgedAt,
    liveLaunchCount: settings?.liveLaunchCount ?? 0,
    firstLaunchCapUsd: FIRST_LIVE_LAUNCH_HARD_CAP_USD,
    perAdBudgetUsd: perAdBudget,
    optimizationGoal: settings?.defaultOptimizationGoal ?? 'CONVERSIONS',
    placementType: settings?.defaultPlacementType ?? 'advantage_plus',
    defaultPageId: settings?.defaultPageId ?? null,
    defaultOfferUrl: concept?.offerUrl ?? '',
    defaultCountries: settings?.defaultTargetingCountries ?? ['US'],
    defaultAgeMin: settings?.defaultAgeMin ?? 18,
    defaultAgeMax: settings?.defaultAgeMax ?? 65,
    metaPages: metaPages.map((p) => ({ pageId: p.pageId, pageName: p.pageName })),
    accountCurrency: metaConn?.accountCurrency ?? 'USD',
    minDailyBudgetMinor: metaConn?.minDailyBudgetMinor ?? null,
    committedTodayUsd: launchCap.committedTodayUsd,
    capUsd: launchCap.capUsd,
    remainingUsd: launchCap.allowed
      ? launchCap.remainingUsd
      : Math.max(0, launchCap.capUsd - launchCap.committedTodayUsd),
  };

  const isProcessing = job.status === 'queued' || job.status === 'processing';
  const isFailed = job.status === 'failed';
  // Polish-25.6 Commit 37: distinguish "MakeUGC still processing after
  // the 60-min poll cap" from a hard failure. Worker stamps
  // metadata.polish25_processing_timeout=true + the stuck videoId on
  // cap-hit; the run detail renders a Recheck card instead of the red
  // error UI so the operator can recover the video without paying a
  // second credit for regeneration.
  const jobMeta = (job.metadata ?? {}) as Record<string, unknown>;
  const isProcessingTimeout = isFailed && jobMeta['polish25_processing_timeout'] === true;
  const stuckVideoId =
    typeof jobMeta['polish25_stuck_video_id'] === 'string'
      ? (jobMeta['polish25_stuck_video_id'] as string)
      : typeof jobMeta['polish25_makeugc_video_id'] === 'string'
        ? (jobMeta['polish25_makeugc_video_id'] as string)
        : null;
  const timeoutAtRaw = jobMeta['polish25_processing_timeout_at'];
  const timeoutAt = typeof timeoutAtRaw === 'string' ? timeoutAtRaw : null;

  // Polish-9.2: render the actual picked pipeline (label + canonical
  // providerChoice) instead of the legacy format-derived "avatar talking
  // head" placeholder. Falls back to the format column for legacy rows.
  const jobPipelineEnum = pipelineFromString(job.pickedPipeline);
  const jobPipelineDesc = jobPipelineEnum ? describePipeline(jobPipelineEnum) : null;

  return (
    <AppShell crumbs={[{ label: 'Runs' }, { label: job.id.slice(0, 8) }]} contentClass="max-w-5xl">
      <PageHeader
        title={`Generation ${job.id.slice(0, 8)}`}
        actions={
          <Badge variant={jobStatusVariant(job.status)}>
            {job.status.replace(/_/g, ' ').toUpperCase()}
          </Badge>
        }
        meta={
          // Polish-25.2 Commit 12: dropped the "Provider" cell (users
          // shouldn't need to see `makeugc` / `heygen` etc. — that's
          // implementation detail). Pipeline label kept but comes
          // through the descriptor's user-facing label (e.g.
          // "Instant UGC ad").
          <div className="grid w-full gap-x-6 gap-y-1 text-xs sm:grid-cols-2 md:grid-cols-4">
            <div>
              <span className="text-fg-subtle uppercase tracking-wider">Variants </span>
              <span className="font-mono">{job.variantCount ?? variants.length}</span>
            </div>
            {jobPipelineDesc && (
              <div>
                <span className="text-fg-subtle uppercase tracking-wider">Format </span>
                <span className="font-mono">{jobPipelineDesc.label}</span>
                {/* Polish-25.3 Commit 23: mirror the Beta tag from the
                    generate-form picker on any static-openai run so
                    approvers see the same expectation-setting signal
                    the operator saw at submit time. */}
                {jobPipelineEnum === 'static_openai_image' && (
                  <span
                    className="border-[color:var(--accent-warning,#a68a00)]/40 bg-[color:var(--accent-warning,#a68a00)]/10 ml-2 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[color:var(--accent-warning,#a68a00)]"
                    aria-label="Beta pipeline"
                  >
                    Beta
                  </span>
                )}
              </div>
            )}
            {!jobPipelineDesc && conceptType === 'ugc' && (
              <div>
                <span className="text-fg-subtle uppercase tracking-wider">Format </span>
                <span className="font-mono">
                  {job.format === 'cinematic_voiceover'
                    ? 'cinematic voiceover'
                    : 'avatar talking head'}
                </span>
              </div>
            )}
            {job.estimatedCostUsd != null && (
              <div>
                <span className="text-fg-subtle uppercase tracking-wider">Est cost </span>
                <span className="font-mono">${job.estimatedCostUsd}</span>
              </div>
            )}
            <div>
              <span className="text-fg-subtle uppercase tracking-wider">Queued </span>
              <span className="font-mono">{formatDateTime(job.requestedAt)}</span>
            </div>
          </div>
        }
      />

      <div className="mb-6">
        <JobTimeline
          conceptType={conceptType as 'static' | 'ugc'}
          job={{
            status: job.status,
            mode: job.mode ?? 'live',
            requestedAt: job.requestedAt,
            completedAt: job.completedAt,
            variantCount: job.variantCount,
            providerChoice: job.providerChoice,
            // Polish-25.3 Commit 18a: thread the picked pipeline
            // so JobTimeline can render a friendly descriptor
            // label instead of the raw providerChoice enum.
            pickedPipeline: job.pickedPipeline,
            errorMessage: job.errorMessage,
            metadata: job.metadata,
          }}
          variants={sortedVariants.map((v) => ({
            id: v.id,
            status: v.status,
            fileUrl: v.fileUrl,
            createdAtIso: v.createdAt.toISOString(),
          }))}
        />
      </div>

      {isProcessing && (
        // Polish-25.2 Commit 12: silent 4s meta refresh (no user-
        // facing "this page auto-refreshes" copy). The Working card
        // uses a pulsing dot so users see something IS happening
        // without a countdown timer or refresh notice.
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span aria-hidden className="bg-fg inline-block h-2 w-2 animate-pulse rounded-full" />
              Working
            </CardTitle>
          </CardHeader>
          <CardContent className="text-fg-muted text-sm">
            Generation in progress. The pipeline usually finishes in a few minutes.
            <meta httpEquiv="refresh" content="4" />
          </CardContent>
        </Card>
      )}

      {isProcessingTimeout && stuckVideoId && (
        <ProcessingTimeoutCard jobId={job.id} stuckVideoId={stuckVideoId} timeoutAt={timeoutAt} />
      )}

      {isFailed && !isProcessingTimeout && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[color:var(--accent-negative)]">Generation failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(() => {
              const t = translateGenerationError(job.errorMessage ?? null);
              return (
                <>
                  <p className="text-fg text-sm">{t.userMessage}</p>
                  <p className="text-fg-muted text-xs">{t.suggestion}</p>
                  {t.retryable && conceptIds[0] && (
                    <a
                      href={`/concepts/${conceptIds[0]}/generate`}
                      className="bg-bg-surface hover:bg-bg-surfaceHover border-border inline-flex items-center rounded-sm border px-3 py-1.5 text-xs font-medium"
                    >
                      Retry generation
                    </a>
                  )}
                  {job.errorMessage && (
                    <details className="text-fg-subtle text-xs">
                      <summary className="cursor-pointer">Technical details</summary>
                      <pre className="bg-bg-elevated mt-2 overflow-x-auto rounded-md p-2 font-mono text-[10px] leading-relaxed">
                        {job.errorMessage}
                      </pre>
                    </details>
                  )}
                </>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {!isProcessing && !isFailed && (
        <JobReviewClient
          jobId={job.id}
          conceptType={conceptType as 'static' | 'ugc'}
          variants={sortedVariants.map((v) => ({
            id: v.id,
            fileUrl: v.fileUrl,
            aspectRatio: v.aspectRatio,
            status: v.status,
            createdAtIso: v.createdAt.toISOString(),
            headline: v.headline,
            primaryText: v.primaryText,
            description: v.description,
            isClipPart: v.isClipPart,
            clipIndex: v.clipIndex,
            format: v.format,
            // Polish-25.3 Commit 18b-hotfix-2: threaded so the
            // variant-level image predicate on the review client
            // can flip static-image variants to <img> even when
            // the concept was uploaded as UGC video.
            imageStoragePath: v.imageStoragePath,
          }))}
          launchSnapshot={launchSnapshot}
          // Polish-25.2 Commit 13 + 14: gate the Launch button on
          // Meta being FULLY connected. Beyond status='active', we
          // require a picked Business Manager + at least one ad
          // account — a partially-configured row would otherwise
          // satisfy the boolean check while being unusable for
          // launch (root cause of the operator's stuck row on
          // 25.2.2 walkthrough).
          hasMetaConnection={
            !!metaConn &&
            !!metaConn.businessManagerId &&
            Array.isArray(metaConn.adAccountIds) &&
            metaConn.adAccountIds.length > 0
          }
          // Polish-25.2 Commit 15: launched-ad rejections surface as
          // an inline banner above the review pane. Empty array →
          // banner hidden.
          launchProblems={launchProblems.map((r) => ({
            id: r.id,
            status: r.status,
            errorMessage: r.errorMessage ?? null,
            launchedAtIso: r.launchedAt?.toISOString() ?? null,
          }))}
          launchPresets={launchPresets}
        />
      )}
    </AppShell>
  );
}

function jobStatusVariant(status: string): BadgeVariant {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'processing' || status === 'queued') return 'warning';
  return 'outline';
}
