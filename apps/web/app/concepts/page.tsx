import Link from 'next/link';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ConceptUploadTabs } from './concept-upload-tabs';

export const metadata = { title: 'Concepts' };

export default async function ConceptsPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const recent = await db.query.concepts.findMany({
    where: and(eq(schema.concepts.userId, userId), isNull(schema.concepts.deletedAt)),
    orderBy: desc(schema.concepts.createdAt),
    columns: {
      id: true,
      contentType: true,
      name: true,
      nicheTag: true,
      createdAt: true,
      staticHeadline: true,
    },
    limit: 20,
  });

  // Polish-25.1 Commit 10b: upload is the ONE thing this page is
  // for. Header + upload tabs sit above the fold; recent list moves
  // to a de-emphasized bottom section so first-time users see the
  // primary action immediately + returning users still have their
  // history one scroll away.
  return (
    <AppShell crumbs={[{ label: 'Concepts' }]} contentClass="max-w-3xl">
      <PageHeader
        title="Upload a concept"
        subtitle="Point Ads Bot at a winning UGC video or static ad. Generate variations you can review and launch."
      />

      <Card>
        <CardHeader>
          <CardTitle>New concept</CardTitle>
          <CardDescription>
            Pick the path that matches the source — image with copy (Static) or video (UGC).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConceptUploadTabs />
        </CardContent>
      </Card>

      {recent.length > 0 && (
        <section className="mt-12">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-fg-muted text-xs font-medium uppercase tracking-wider">
              Recent concepts
            </h2>
            <span className="text-fg-subtle text-xs">Last {recent.length}</span>
          </div>
          <ul className="border-border-subtle border-y">
            {recent.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/concepts/${c.id}`}
                  className="hover:bg-bg-surfaceHover/50 border-border-subtle group flex items-center justify-between gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="min-w-0">
                      <p className="text-fg group-hover:text-fg truncate text-sm font-medium">
                        {c.name ?? c.staticHeadline ?? labelForContentType(c.contentType)}
                      </p>
                      <p className="text-fg-muted mt-0.5 text-xs">
                        {c.nicheTag ? `${c.nicheTag} · ` : ''}
                        <span className="font-mono">{formatDateTime(c.createdAt)}</span>
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    {labelForContentType(c.contentType).toUpperCase()}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}

function labelForContentType(t: string): string {
  if (t === 'static') return 'Static';
  if (t === 'ugc') return 'UGC video';
  // Legacy Phase 1 values.
  if (t === 'video') return 'Video (legacy)';
  if (t === 'text') return 'Text (legacy)';
  return t;
}
