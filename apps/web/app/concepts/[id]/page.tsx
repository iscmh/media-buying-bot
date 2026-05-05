import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Concept — Media Buying Bot' };

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ConceptDetailPage({ params }: Props) {
  const { id } = await params;
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const concept = await db.query.concepts.findFirst({
    where: and(
      eq(schema.concepts.id, id),
      eq(schema.concepts.userId, userId),
      isNull(schema.concepts.deletedAt),
    ),
  });
  if (!concept) notFound();

  const jobs = await db.query.generationJobs.findMany({
    where: eq(schema.generationJobs.userId, userId),
    orderBy: desc(schema.generationJobs.requestedAt),
    columns: {
      id: true,
      status: true,
      mode: true,
      variantCount: true,
      providerChoice: true,
      estimatedCostUsd: true,
      requestedAt: true,
      completedAt: true,
      conceptIds: true,
    },
    limit: 50,
  });
  const ourJobs = jobs.filter((j) => j.conceptIds?.includes(id));

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">
            {concept.staticHeadline ?? labelForType(concept.contentType)}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {labelForType(concept.contentType)}
            {concept.nicheTag ? ` · ${concept.nicheTag}` : ''}
            {concept.sourcePlatform ? ` · from ${concept.sourcePlatform}` : ''}
            {' · uploaded '}
            {formatDateTime(concept.createdAt)}
          </p>
        </div>
        <Button asChild size="lg">
          <Link href={`/concepts/${concept.id}/generate`}>Generate variants</Link>
        </Button>
      </header>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Source</CardTitle>
          <CardDescription>Storage path: {concept.fileUrl ?? '—'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {concept.contentType === 'static' && (
            <>
              <Row label="Headline" value={concept.staticHeadline ?? '—'} />
              <Row label="Primary text" value={concept.staticPrimaryText ?? '—'} />
              {concept.staticDescription && (
                <Row label="Description" value={concept.staticDescription} />
              )}
            </>
          )}
          {concept.contentType === 'ugc' && concept.ugcOriginalScript && (
            <Row label="Original script" value={concept.ugcOriginalScript} />
          )}
          {concept.offerUrl && <Row label="Offer URL" value={concept.offerUrl} />}
          {concept.originalCpaUsd != null && (
            <Row label="Original CPA" value={`$${concept.originalCpaUsd}`} />
          )}
          {concept.originalRoas != null && (
            <Row label="Original ROAS" value={String(concept.originalRoas)} />
          )}
          {concept.description && <Row label="Notes" value={concept.description} />}
        </CardContent>
      </Card>

      {ourJobs.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Generation history</h2>
          <ul className="space-y-2">
            {ourJobs.map((j) => (
              <li key={j.id}>
                <Link
                  href={`/jobs/${j.id}`}
                  className="bg-card hover:bg-accent/30 flex items-center justify-between rounded-lg border p-4 transition-colors"
                >
                  <div className="flex flex-col gap-0.5 text-sm">
                    <span className="font-medium">
                      {j.variantCount ?? 0} variants{' '}
                      {j.providerChoice && (
                        <span className="text-muted-foreground">· {j.providerChoice}</span>
                      )}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {j.status}
                      {j.mode === 'mock' ? ' · MOCK' : ''}
                      {j.estimatedCostUsd != null && ` · est $${j.estimatedCostUsd}`}
                      {' · '}
                      {formatDateTime(j.requestedAt)}
                    </span>
                  </div>
                  <span className="text-muted-foreground text-xs">View →</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="text-muted-foreground sm:w-44">{label}</span>
      <span className="whitespace-pre-line">{value}</span>
    </div>
  );
}

function labelForType(t: string): string {
  if (t === 'static') return 'Static concept';
  if (t === 'ugc') return 'UGC video concept';
  if (t === 'video') return 'Video concept (legacy)';
  if (t === 'text') return 'Text concept (legacy)';
  return t;
}
