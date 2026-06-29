import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { assertDailyCostCap, getDb, schema } from '@mbb/db';
import { type ConceptType } from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadConnectedProviders, loadKieAiBalance } from '../actions';
import { GenerationRequestForm } from '../generation-request-form';

export const metadata = { title: 'Generate variants (advanced) — Ads Bot' };

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Polish-19 Commit 3: the legacy full control-panel form, preserved
 * verbatim at /concepts/[id]/generate/advanced. The simplified form
 * at the parent route links here from its Advanced disclosure for
 * users who want intensity / reference upload / format override /
 * provider picker / per-pipeline cost breakdown.
 *
 * Identical loader to the pre-Polish-19 page.tsx — we just moved it
 * one route down so the parent path can host the new minimal form.
 */
export default async function GenerateAdvancedPage({ params }: Props) {
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
  if (concept.contentType !== 'static' && concept.contentType !== 'ugc') notFound();

  let sourceVideoUrl: string | null = null;
  if (concept.contentType === 'ugc' && concept.fileUrl) {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.storage.from('concepts').createSignedUrl(concept.fileUrl, 3600);
    sourceVideoUrl = data?.signedUrl ?? null;
  }

  const capCheck = await assertDailyCostCap(userId, 0);
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { liveGenerationAcknowledgedAt: true },
  });
  const connectedProviders = await loadConnectedProviders(userId);
  const kieBalance = await loadKieAiBalance(userId);

  return (
    <AppShell
      crumbs={[
        { label: 'Concepts', href: '/concepts' },
        { label: 'Generate', href: `/concepts/${id}/generate` },
        { label: 'Advanced' },
      ]}
      contentClass="max-w-2xl"
    >
      <PageHeader
        title="Generate variants (advanced)"
        subtitle={
          (concept.staticHeadline
            ? `From: "${concept.staticHeadline}"`
            : 'From your uploaded concept') + (concept.nicheTag ? ` · ${concept.nicheTag}` : '')
        }
      />

      <GenerationRequestForm
        conceptId={concept.id}
        conceptType={concept.contentType as ConceptType}
        spentTodayUsd={capCheck.spentTodayUsd}
        capUsd={capCheck.capUsd}
        liveAcknowledged={!!settings?.liveGenerationAcknowledgedAt}
        connectedProviders={connectedProviders}
        kieBalance={kieBalance}
        sourceVideoUrl={sourceVideoUrl}
      />
    </AppShell>
  );
}
