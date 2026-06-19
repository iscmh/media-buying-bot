import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { assertDailyCostCap, getDb, schema } from '@mbb/db';
import { type ConceptType } from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadConnectedProviders } from './actions';
import { GenerationRequestForm } from './generation-request-form';

export const metadata = { title: 'Generate variants — Ads Bot' };

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
      fileUrl: true,
    },
  });
  if (!concept) notFound();
  if (concept.contentType !== 'static' && concept.contentType !== 'ugc') {
    // Legacy 'video'/'text' concepts can't drive Phase 3a generation.
    notFound();
  }

  // Polish-14.1: sign a short-lived URL for UGC sources so the form can
  // detect duration client-side (hidden <video> + onloadedmetadata).
  // The cost preview + worker target_duration_seconds both ride on this.
  let sourceVideoUrl: string | null = null;
  if (concept.contentType === 'ugc' && concept.fileUrl) {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.storage.from('concepts').createSignedUrl(concept.fileUrl, 3600);
    sourceVideoUrl = data?.signedUrl ?? null;
  }

  // Pre-compute remaining cost cap for the form's "X% used today" hint.
  const capCheck = await assertDailyCostCap(userId, 0);
  const spentTodayUsd = capCheck.spentTodayUsd;
  const capUsd = capCheck.capUsd;

  // Phase 3b: read live-mode acknowledgment to decide whether to show the
  // first-time confirmation dialog. Once set, the dialog is skipped.
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { liveGenerationAcknowledgedAt: true },
  });
  const liveAcknowledged = !!settings?.liveGenerationAcknowledgedAt;

  // Polish-4: which providers does the user have keys for? Drives the
  // Provider + Format pickers.
  const connectedProviders = await loadConnectedProviders(userId);

  return (
    <AppShell
      crumbs={[{ label: 'Concepts', href: '/concepts' }, { label: 'Generate variants' }]}
      contentClass="max-w-2xl"
    >
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Generate variants</h1>
        <p className="text-fg-muted mt-1 text-sm">
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
        liveAcknowledged={liveAcknowledged}
        connectedProviders={connectedProviders}
        sourceVideoUrl={sourceVideoUrl}
      />
    </AppShell>
  );
}
