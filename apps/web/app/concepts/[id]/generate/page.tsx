import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { assertDailyCostCap, getDb, schema } from '@mbb/db';
import { type ConceptType } from '@mbb/shared';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { GenerationRequestForm } from './generation-request-form';

export const metadata = { title: 'Generate variants — Media Buying Bot' };

interface Props {
  params: Promise<{ id: string }>;
}

export default async function GenerateRequestPage({ params }: Props) {
  const { id } = await params;
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const concept = await db.query.concepts.findFirst({
    where: and(
      eq(schema.concepts.id, id),
      eq(schema.concepts.userId, userId),
      isNull(schema.concepts.deletedAt),
    ),
    columns: {
      id: true,
      contentType: true,
      staticHeadline: true,
      nicheTag: true,
    },
  });
  if (!concept) notFound();
  if (concept.contentType !== 'static' && concept.contentType !== 'ugc') {
    // Legacy 'video'/'text' concepts can't drive Phase 3a generation.
    notFound();
  }

  // Pre-compute remaining cost cap for the form's "X% used today" hint.
  const capCheck = await assertDailyCostCap(userId, 0);
  const spentTodayUsd = capCheck.spentTodayUsd;
  const capUsd = capCheck.capUsd;

  return (
    <main className="container mx-auto max-w-2xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Generate variants</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {concept.staticHeadline
            ? `From: "${concept.staticHeadline}"`
            : 'From your uploaded concept'}
          {concept.nicheTag ? ` · ${concept.nicheTag}` : ''}
        </p>
      </header>

      <GenerationRequestForm
        conceptId={concept.id}
        conceptType={concept.contentType as ConceptType}
        spentTodayUsd={spentTodayUsd}
        capUsd={capUsd}
      />
    </main>
  );
}
