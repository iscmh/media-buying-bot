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

  return (
    <AppShell crumbs={[{ label: 'Concepts' }]} contentClass="max-w-3xl">
      <PageHeader
        title="Concepts"
        subtitle="Upload winning creatives. The bot uses them as references when generating fresh variants."
      />

      <Card>
        <CardHeader>
          <CardTitle>Upload a concept</CardTitle>
          <CardDescription>
            Pick the path that matches the source — image with copy (Static) or video (UGC).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConceptUploadTabs />
        </CardContent>
      </Card>

      <section className="mt-10">
        <h2 className="text-fg mb-3 text-xs font-medium uppercase tracking-wider">
          Recent concepts
        </h2>
        {recent.length === 0 ? (
          <p className="text-fg-muted border-border-subtle border-y py-8 text-center text-sm">
            No concepts yet. Upload one above to get started.
          </p>
        ) : (
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
        )}
      </section>
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
