import Link from 'next/link';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { ListTodo } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AppShell } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/shell/empty-state';
import { PageHeader } from '@/components/shell/page-header';
import { formatDateTime } from '@/lib/format/date';
import { friendlyPipeline } from '@/lib/format/pipeline-label';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Pending approval' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.5 Commit 27: cross-run Pending page.
 *
 * Every generated_creatives row awaiting operator approval, across
 * every run, in one dense table. The old flow required a media
 * buyer to open each run individually to see what still needed
 * approval; this page shows the queue app-wide.
 *
 * Clicking a row navigates to the parent run so the approve/reject
 * action stays where the launch-approval flow already lives.
 * Bulk-approve directly from this page is deferred to a follow-up
 * commit — this commit ships the visibility, next commit ships the
 * multi-select action bar.
 */
export default async function PendingPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const pending = await db
    .select({
      id: schema.generatedCreatives.id,
      generationJobId: schema.generatedCreatives.generationJobId,
      headline: schema.generatedCreatives.headline,
      primaryText: schema.generatedCreatives.primaryText,
      fileUrl: schema.generatedCreatives.fileUrl,
      format: schema.generatedCreatives.format,
      createdAt: schema.generatedCreatives.createdAt,
      jobStatus: schema.generationJobs.status,
      jobRequestedAt: schema.generationJobs.requestedAt,
    })
    .from(schema.generatedCreatives)
    .innerJoin(
      schema.generationJobs,
      eq(schema.generatedCreatives.generationJobId, schema.generationJobs.id),
    )
    .where(
      and(
        eq(schema.generatedCreatives.userId, userId),
        eq(schema.generatedCreatives.status, 'ready_for_review'),
        isNull(schema.generatedCreatives.deletedAt),
      ),
    )
    .orderBy(desc(schema.generatedCreatives.createdAt))
    .limit(200);

  return (
    <AppShell crumbs={[{ label: 'Pending approval' }]}>
      <PageHeader
        title="Pending approval"
        subtitle={
          pending.length === 0
            ? 'All caught up. New variants show up here as jobs complete.'
            : `${pending.length} ${pending.length === 1 ? 'variant' : 'variants'} across runs waiting for review.`
        }
      />

      {pending.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="Nothing waiting."
          description="Every completed run has been reviewed. Kick off a new generation from Concepts."
        />
      ) : (
        <div className="overflow-x-auto rounded-sm border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Preview</TableHead>
                <TableHead>Headline</TableHead>
                <TableHead>Primary text</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Generated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    {v.fileUrl ? (
                      <img
                        src={v.fileUrl}
                        alt=""
                        className="bg-bg-inset h-10 w-10 rounded object-cover"
                      />
                    ) : (
                      <div className="bg-bg-inset h-10 w-10 rounded" />
                    )}
                  </TableCell>
                  <TableCell className="text-fg max-w-[24ch] truncate text-xs font-medium">
                    {v.headline ?? '(no headline)'}
                  </TableCell>
                  <TableCell className="text-fg-muted line-clamp-2 max-w-[40ch] text-xs">
                    {v.primaryText ?? '-'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/runs/${v.generationJobId}`}
                      className="text-fg hover:text-[color:var(--accent-amber)]"
                    >
                      {v.generationJobId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-fg-muted text-xs">
                    {friendlyPipeline(v.format)}
                  </TableCell>
                  <TableCell className="text-fg-muted font-mono text-xs">
                    {formatDateTime(v.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/runs/${v.generationJobId}`}
                      className="font-mono text-xs text-[color:var(--accent-amber)] hover:underline"
                    >
                      review →
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </AppShell>
  );
}
