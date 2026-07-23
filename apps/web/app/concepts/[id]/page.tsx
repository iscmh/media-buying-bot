import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { ArrowRight } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
import { Button } from '@/components/ui/button';
import { AppShell } from '@/components/shell/app-shell';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { ConceptNameEdit } from './concept-name-edit';

export const metadata = { title: 'Concept' };

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

  // Sign a short-lived URL for the source file so the hero preview can
  // render it. Concepts bucket is private; getPublicUrl would 401.
  // 1h expiry — page is short-lived; user re-loads if they linger.
  let previewUrl: string | null = null;
  if (concept.fileUrl) {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.storage.from('concepts').createSignedUrl(concept.fileUrl, 3600);
    previewUrl = data?.signedUrl ?? null;
  }

  const displayName = concept.name ?? concept.staticHeadline ?? labelForType(concept.contentType);

  // Polish-25.1 Commit 10b: single-CTA layout. Hero preview + one
  // primary Generate button; metadata + history collapsed into a
  // <details> drawer at the bottom so returning users can still
  // inspect the source + prior jobs without cluttering the primary
  // action.
  return (
    <AppShell
      crumbs={[{ label: 'Concepts', href: '/concepts' }, { label: displayName }]}
      contentClass="max-w-3xl"
    >
      <div className="mb-4">
        <ConceptNameEdit conceptId={concept.id} initialName={displayName} />
        <p className="text-fg-muted mt-1 text-xs">
          {labelForType(concept.contentType)}
          {concept.nicheTag ? ` · ${concept.nicheTag}` : ''}
          {' · uploaded '}
          <span className="font-mono">{formatDateTime(concept.createdAt)}</span>
        </p>
      </div>

      {/* Polish-25.2 Commit 17: capped the source preview at 50vh
          instead of 65vh so the Generate CTA reliably lands above
          the fold on typical desktop viewports. Operator report:
          the CTA required a scroll to reach on a 1440x900 screen
          when the source video was tall (portrait UGC). */}
      {previewUrl && (
        <div className="border-border mb-6 overflow-hidden rounded-md border bg-black">
          {concept.contentType === 'ugc' ? (
            <video
              src={previewUrl}
              controls
              playsInline
              className="mx-auto block max-h-[50vh] w-auto max-w-full bg-black object-contain"
            />
          ) : (
            <img
              src={previewUrl}
              alt={displayName}
              className="mx-auto block max-h-[50vh] w-auto max-w-full bg-black object-contain"
            />
          )}
        </div>
      )}

      {/* Polish-25.2 Commit 17: killed the "Ready to generate your
          first variant?" hint copy — it was redundant next to the
          giant CTA button that follows. Prior-generation count
          survives as a muted subline under the CTA. Button is
          centered + full-width on mobile, auto width on desktop
          for visual weight parity with the source preview. */}
      <div className="mb-8 flex flex-col items-center gap-2">
        <Button asChild size="lg" className="w-full gap-2 sm:w-auto sm:px-8">
          <Link href={`/concepts/${concept.id}/generate`}>
            Generate variants
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </Button>
        {ourJobs.length > 0 && (
          <p className="text-fg-muted text-xs">
            {ourJobs.length} generation{ourJobs.length === 1 ? '' : 's'} so far.
          </p>
        )}
      </div>

      <details className="border-border-subtle group mb-4 rounded-md border">
        <summary className="text-fg-muted hover:text-fg cursor-pointer list-none px-4 py-2.5 text-xs font-medium uppercase tracking-wider transition-colors">
          Source metadata
          <span className="ml-2 text-[10px] normal-case tracking-normal">(click to expand)</span>
        </summary>
        <div className="border-border-subtle space-y-3 border-t p-4 text-sm">
          <Row label="File" value={concept.fileUrl ?? '—'} mono />
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
          {concept.offerUrl && <Row label="Offer URL" value={concept.offerUrl} mono />}
          {concept.originalCpaUsd != null && (
            <Row label="Original CPA" value={`$${concept.originalCpaUsd}`} mono />
          )}
          {concept.originalRoas != null && (
            <Row label="Original ROAS" value={String(concept.originalRoas)} mono />
          )}
          {concept.description && <Row label="Notes" value={concept.description} />}
          {concept.sourcePlatform && <Row label="Source" value={concept.sourcePlatform} />}
        </div>
      </details>

      {ourJobs.length > 0 && (
        <details className="border-border-subtle group rounded-md border">
          <summary className="text-fg-muted hover:text-fg cursor-pointer list-none px-4 py-2.5 text-xs font-medium uppercase tracking-wider transition-colors">
            Generation history
            <span className="ml-2 text-[10px] normal-case tracking-normal">
              ({ourJobs.length} run{ourJobs.length === 1 ? '' : 's'})
            </span>
          </summary>
          <ul className="border-border-subtle border-t">
            {ourJobs.map((j) => (
              <li key={j.id}>
                <Link
                  href={`/runs/${j.id}`}
                  className="hover:bg-bg-surfaceHover/50 border-border-subtle flex items-center justify-between gap-3 border-b px-4 py-2.5 transition-colors last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                    <span className="text-fg font-medium">
                      <span className="font-mono">{j.variantCount ?? 0}</span> variants
                      {j.providerChoice && (
                        <span className="text-fg-muted ml-1.5 font-mono text-xs">
                          · {j.providerChoice}
                        </span>
                      )}
                    </span>
                    <span className="text-fg-muted text-xs">
                      <span className="font-mono">{j.status}</span>
                      {j.estimatedCostUsd != null && (
                        <span className="font-mono"> · est ${j.estimatedCostUsd}</span>
                      )}
                      {' · '}
                      <span className="font-mono">{formatDateTime(j.requestedAt)}</span>
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </AppShell>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="text-fg-muted text-xs uppercase tracking-wider sm:w-44 sm:pt-0.5">
        {label}
      </span>
      <span className={'text-fg whitespace-pre-line' + (mono ? ' font-mono' : '')}>{value}</span>
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
