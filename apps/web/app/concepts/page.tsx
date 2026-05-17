import Link from 'next/link';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { FileVideo, ImageIcon } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
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
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Concepts</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Upload winning creatives. The bot uses them as references when generating fresh variants.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload a concept</CardTitle>
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
          <h2 className="text-fg mb-3 text-base font-semibold">Recent concepts</h2>
          <ul className="space-y-2">
            {recent.map((c) => {
              const Icon = c.contentType === 'ugc' ? FileVideo : ImageIcon;
              return (
                <li key={c.id}>
                  <Link
                    href={`/concepts/${c.id}`}
                    className="bg-bg-elevated hover:bg-bg-hover group flex items-center justify-between gap-3 rounded-md border p-3 transition-colors"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="bg-bg-active text-fg-muted flex h-9 w-9 shrink-0 items-center justify-center rounded">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-fg truncate text-sm font-medium">
                          {c.name ?? c.staticHeadline ?? labelForContentType(c.contentType)}
                        </p>
                        <p className="text-fg-muted text-xs">
                          {c.nicheTag ? `${c.nicheTag} · ` : ''}
                          {formatDateTime(c.createdAt)}
                        </p>
                      </div>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      {labelForContentType(c.contentType)}
                    </Badge>
                  </Link>
                </li>
              );
            })}
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
