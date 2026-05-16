import { notFound } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { assertDailyLaunchBudgetCap, getDb, schema } from '@mbb/db';
import { FIRST_LIVE_LAUNCH_HARD_CAP_USD, PLATFORM_HARD_AD_DAILY_BUDGET_USD } from '@mbb/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { JobReviewClient } from './job-review-client';

export const metadata = { title: 'Variant review — Ads Bot' };
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
    committedTodayUsd: launchCap.committedTodayUsd,
    capUsd: launchCap.capUsd,
    remainingUsd: launchCap.allowed
      ? launchCap.remainingUsd
      : Math.max(0, launchCap.capUsd - launchCap.committedTodayUsd),
  };

  return (
    <AppShell
      crumbs={[{ label: 'Jobs', href: '/concepts' }, { label: job.id.slice(0, 8) }]}
      contentClass="max-w-5xl"
    >
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Variants</h1>
        <p className="text-fg-muted mt-1 text-sm">
          {job.variantCount ?? variants.length} requested · {job.providerChoice ?? 'gemini+claude'}{' '}
          · status <strong>{job.status}</strong>
          {job.mode === 'mock' && ' · MOCK'}
          {job.estimatedCostUsd != null && ` · est $${job.estimatedCostUsd}`}
          {' · queued '}
          {formatDateTime(job.requestedAt)}
        </p>
      </header>

      {job.status === 'queued' || job.status === 'processing' ? (
        <Card>
          <CardHeader>
            <CardTitle>Generating…</CardTitle>
            <CardDescription>
              {conceptType === 'ugc'
                ? 'Analyzing the source clip then generating variants.'
                : 'Generating image + copy variants.'}{' '}
              This page auto-refreshes every 4 seconds.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RefreshHint />
          </CardContent>
        </Card>
      ) : job.status === 'failed' ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle>Generation failed</CardTitle>
            <CardDescription>{job.errorMessage ?? 'Unknown error.'}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
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

function RefreshHint() {
  return (
    <>
      <div className="bg-muted-foreground/40 inline-block h-2 w-2 animate-pulse rounded-full" />
      <span className="ml-2 text-sm">Working…</span>
      <meta httpEquiv="refresh" content="4" />
    </>
  );
}
