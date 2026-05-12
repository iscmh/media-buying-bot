import { notFound } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { assertDailyLaunchBudgetCap, getDb, schema } from '@mbb/db';
import { PLATFORM_HARD_AD_DAILY_BUDGET_USD } from '@mbb/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { JobReviewClient } from './job-review-client';

export const metadata = { title: 'Variant review — Media Buying Bot' };
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
          columns: { contentType: true },
        })
      : null;
  const conceptType = concept?.contentType ?? 'static';

  // Phase 4a: launch context — ack + budget cap snapshot so the dialog
  // can show "you have $X remaining today" without an extra round trip.
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: {
      launchAcknowledgedAt: true,
      defaultAdDailyBudgetUsd: true,
      defaultOptimizationGoal: true,
      defaultPlacementType: true,
    },
  });
  const perAdBudget = Math.min(
    Number(settings?.defaultAdDailyBudgetUsd ?? 10),
    PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  );
  const launchCap = await assertDailyLaunchBudgetCap(userId, 0);
  const launchSnapshot = {
    acknowledged: !!settings?.launchAcknowledgedAt,
    perAdBudgetUsd: perAdBudget,
    optimizationGoal: settings?.defaultOptimizationGoal ?? 'CONVERSIONS',
    placementType: settings?.defaultPlacementType ?? 'advantage_plus',
    committedTodayUsd: launchCap.allowed
      ? launchCap.committedTodayUsd
      : launchCap.committedTodayUsd,
    capUsd: launchCap.capUsd,
    remainingUsd: launchCap.allowed
      ? launchCap.remainingUsd
      : Math.max(0, launchCap.capUsd - launchCap.committedTodayUsd),
  };

  return (
    <main className="container mx-auto max-w-5xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Variants</h1>
        <p className="text-muted-foreground mt-1 text-sm">
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
    </main>
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
