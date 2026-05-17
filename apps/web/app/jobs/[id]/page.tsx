import { notFound } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { assertDailyLaunchBudgetCap, getDb, schema } from '@mbb/db';
import { FIRST_LIVE_LAUNCH_HARD_CAP_USD, PLATFORM_HARD_AD_DAILY_BUDGET_USD } from '@mbb/shared';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { JobReviewClient } from './job-review-client';
import { JobTimeline } from './job-timeline';

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

  const conceptIds = job.conceptIds ?? [];
  const concept =
    conceptIds.length > 0
      ? await db.query.concepts.findFirst({
          where: eq(schema.concepts.id, conceptIds[0]!),
          columns: { contentType: true, offerUrl: true },
        })
      : null;
  const conceptType = concept?.contentType ?? 'static';

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
  const metaConn = await db.query.metaConnections.findFirst({
    where: and(
      eq(schema.metaConnections.userId, userId),
      eq(schema.metaConnections.status, 'active'),
    ),
    columns: { accountCurrency: true, minDailyBudgetMinor: true },
  });
  const perAdBudget = Math.min(
    Number(settings?.defaultAdDailyBudgetUsd ?? 10),
    PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  );
  const launchCap = await assertDailyLaunchBudgetCap(userId, 0);
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

  return (
    <AppShell
      crumbs={[{ label: 'Jobs', href: '/concepts' }, { label: job.id.slice(0, 8) }]}
      contentClass="max-w-5xl"
    >
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">Variants</h1>
          <Badge variant={jobStatusVariant(job.status)}>{job.status.replace(/_/g, ' ')}</Badge>
        </div>
        <div className="text-fg-muted mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 md:grid-cols-4">
          <div>
            <span className="text-fg-subtle">Requested </span>
            <span className="font-mono">{job.variantCount ?? variants.length} variants</span>
          </div>
          <div>
            <span className="text-fg-subtle">Provider </span>
            <span className="font-mono">{job.providerChoice ?? 'gemini+claude'}</span>
          </div>
          {job.estimatedCostUsd != null && (
            <div>
              <span className="text-fg-subtle">Est cost </span>
              <span className="font-mono">${job.estimatedCostUsd}</span>
            </div>
          )}
          <div>
            <span className="text-fg-subtle">Queued </span>
            <span className="font-mono">{formatDateTime(job.requestedAt)}</span>
          </div>
        </div>
      </header>

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
            errorMessage: job.errorMessage,
            metadata: job.metadata,
          }}
          variants={variants.map((v) => ({
            id: v.id,
            status: v.status,
            fileUrl: v.fileUrl,
            createdAtIso: v.createdAt.toISOString(),
          }))}
        />
      </div>

      {isProcessing && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Working…</CardTitle>
          </CardHeader>
          <CardContent className="text-fg-muted text-sm">
            This page auto-refreshes every 4 seconds.
            <meta httpEquiv="refresh" content="4" />
          </CardContent>
        </Card>
      )}

      {isFailed && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-[color:var(--destructive-color)]">
              Generation failed
            </CardTitle>
          </CardHeader>
          <CardContent className="text-fg-muted text-sm">
            {job.errorMessage ?? 'Unknown error.'}
          </CardContent>
        </Card>
      )}

      {!isProcessing && !isFailed && (
        <JobReviewClient
          jobId={job.id}
          conceptType={conceptType as 'static' | 'ugc'}
          variants={variants.map((v) => ({
            id: v.id,
            fileUrl: v.fileUrl,
            aspectRatio: v.aspectRatio,
            status: v.status,
            createdAtIso: v.createdAt.toISOString(),
            headline: v.headline,
            primaryText: v.primaryText,
            description: v.description,
          }))}
          launchSnapshot={launchSnapshot}
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
