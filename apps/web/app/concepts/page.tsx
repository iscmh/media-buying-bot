import Link from 'next/link';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ConceptUploadTabs } from './concept-upload-tabs';

export const metadata = { title: 'Concepts — Ads Bot' };

export default async function ConceptsPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const recent = await db.query.concepts.findMany({
    where: and(eq(schema.concepts.userId, userId), isNull(schema.concepts.deletedAt)),
    orderBy: desc(schema.concepts.createdAt),
    columns: {
      id: true,
      contentType: true,
      nicheTag: true,
      createdAt: true,
      staticHeadline: true,
    },
    limit: 20,
  });

  return (
    <AppShell crumbs={[{ label: 'Concepts' }]} contentClass="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Concepts</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Upload winning creative concepts. The bot uses them as references when generating fresh
          variants.
        </p>
      </header>

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

      {recent.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-lg font-semibold">Recent concepts</h2>
          <ul className="space-y-2">
            {recent.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/concepts/${c.id}`}
                  className="bg-card hover:bg-accent/30 flex items-center justify-between rounded-lg border p-4 transition-colors"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {c.staticHeadline ?? labelForContentType(c.contentType)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {labelForContentType(c.contentType)}
                      {c.nicheTag ? ` · ${c.nicheTag}` : ''}
                      {' · '}
                      {formatDateTime(c.createdAt)}
                    </span>
                  </div>
                  <span className="text-muted-foreground text-xs">View →</span>
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
