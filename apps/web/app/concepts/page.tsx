import Link from 'next/link';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { FileVideo, Image as ImageIcon } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { ConceptUploadTabs } from './concept-upload-tabs';

export const metadata = { title: 'Concepts' };

/**
 * Polish-25.5 Commit 27: master-detail split.
 *
 * Left rail = dense concept list (all concepts, newest first). Right
 * pane = upload tabs (the canonical action). Clicking a row navigates
 * to /concepts/[id] where the full preview + generate flow lives.
 *
 * Trader-tool pattern: the workspace shows history + creation surface
 * side-by-side instead of stacking them. Media buyers uploading a new
 * concept can still see the prior 20 while doing it — reference
 * material stays visible.
 *
 * Mobile falls back to single-column: upload card first, list below.
 */
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
    limit: 100,
  });

  return (
    <AppShell crumbs={[{ label: 'Concepts' }]}>
      <PageHeader
        title="Concepts"
        subtitle="Upload a winner or open an existing concept to generate variants."
      />

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="bg-bg-surface flex flex-col rounded-sm border">
          <div className="border-b px-3 py-2">
            <p className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">
              Library
            </p>
            <p className="text-fg-muted mt-0.5 font-mono text-xs">
              {recent.length} {recent.length === 1 ? 'concept' : 'concepts'}
            </p>
          </div>
          {recent.length === 0 ? (
            <div className="text-fg-muted p-4 text-xs">
              Upload your first concept in the panel on the right. It shows up here after upload.
            </div>
          ) : (
            <ul className="max-h-[70vh] overflow-y-auto py-1">
              {recent.map((c) => {
                const Icon = c.contentType === 'ugc' ? FileVideo : ImageIcon;
                return (
                  <li key={c.id}>
                    <Link
                      href={`/concepts/${c.id}`}
                      className="hover:bg-bg-surfaceHover group flex items-start gap-2 px-3 py-2 transition-colors"
                    >
                      <Icon className="text-fg-subtle mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-fg truncate text-xs font-medium">
                          {c.name ?? c.staticHeadline ?? labelForContentType(c.contentType)}
                        </p>
                        <p className="text-fg-muted mt-0.5 truncate text-[11px]">
                          {c.nicheTag ? `${c.nicheTag} · ` : ''}
                          <span className="font-mono">{formatDateTime(c.createdAt)}</span>
                        </p>
                      </div>
                      <span className="text-fg-subtle shrink-0 font-mono text-[10px] uppercase tracking-wider">
                        {c.contentType}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="bg-bg-surface flex flex-col rounded-sm border">
          <div className="border-b px-4 py-3">
            <h2 className="text-fg text-sm font-semibold">New concept</h2>
            <p className="text-fg-muted mt-0.5 text-xs">
              Pick the path that matches the source: image with copy (Static) or video (UGC).
            </p>
          </div>
          <div className="px-4 py-4">
            <ConceptUploadTabs />
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function labelForContentType(t: string): string {
  if (t === 'static') return 'Static';
  if (t === 'ugc') return 'UGC video';
  if (t === 'video') return 'Video (legacy)';
  if (t === 'text') return 'Text (legacy)';
  return t;
}
