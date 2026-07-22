import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { assertDailyCostCap, getDb, schema } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadConnectedProviders } from './actions';
import { SimplifiedGenerationForm } from './simplified-form';

export const metadata = { title: 'Generate variants — Ads Bot' };

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Polish-19 Commit 3: simplified generation page. Three visible
 * controls (count, length, submit) — Pipeline + Voice live in the
 * Advanced disclosure, full control-panel form at
 * /concepts/[id]/generate/advanced.
 */
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
      fileUrl: true,
      staticHeadline: true,
      nicheTag: true,
      // Polish-25.2 Commit 16a: metadata.analysis.video_duration_seconds
      // is populated by Gemini at analyze-concept time. Read it here so
      // the cost estimator reflects the real source duration instead of
      // the 30s fallback (operator report: 45s and 60s uploads were
      // being priced as 30s).
      metadata: true,
    },
  });
  if (!concept) notFound();
  if (concept.contentType !== 'static' && concept.contentType !== 'ugc') notFound();

  // Extract Gemini's measured duration from analysis metadata, if any.
  // Analyzer may write `video_duration_seconds: 0` when it genuinely
  // can't measure — treat 0 as "unknown" and fall through to the
  // simplified-form's 30s default.
  const analysisMeta =
    concept.metadata &&
    typeof concept.metadata === 'object' &&
    'analysis' in (concept.metadata as Record<string, unknown>)
      ? ((concept.metadata as Record<string, unknown>)['analysis'] as Record<
          string,
          unknown
        > | null)
      : null;
  const analysisDurationRaw =
    analysisMeta && typeof analysisMeta['video_duration_seconds'] === 'number'
      ? (analysisMeta['video_duration_seconds'] as number)
      : null;
  const detectedSourceSeconds =
    analysisDurationRaw != null && analysisDurationRaw > 0 ? Math.round(analysisDurationRaw) : null;

  // Polish-14.1: sign a short-lived URL for UGC sources so the form can
  // both preview and read duration client-side. The simplified form
  // doesn't depend on duration detection (user-picked length wins) but
  // still seeds the picker with the detected value when available.
  let sourcePreviewUrl: string | null = null;
  if (concept.contentType === 'ugc' && concept.fileUrl) {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.storage.from('concepts').createSignedUrl(concept.fileUrl, 3600);
    sourcePreviewUrl = data?.signedUrl ?? null;
  }

  const capCheck = await assertDailyCostCap(userId, 0);
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { liveGenerationAcknowledgedAt: true },
  });
  const connectedProviders = await loadConnectedProviders(userId);

  return (
    <AppShell
      crumbs={[{ label: 'Concepts', href: '/concepts' }, { label: 'Generate variations' }]}
      contentClass="max-w-2xl"
    >
      <PageHeader
        title="Generate variations"
        subtitle={
          (concept.staticHeadline
            ? `From "${concept.staticHeadline}"`
            : 'From your uploaded winning ad') + (concept.nicheTag ? ` · ${concept.nicheTag}` : '')
        }
      />

      <SimplifiedGenerationForm
        conceptId={concept.id}
        sourcePreviewUrl={sourcePreviewUrl}
        detectedSourceSeconds={detectedSourceSeconds}
        connectedProviders={connectedProviders}
        spentTodayUsd={capCheck.spentTodayUsd}
        capUsd={capCheck.capUsd}
        liveAcknowledged={!!settings?.liveGenerationAcknowledgedAt}
      />
    </AppShell>
  );
}
