import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { Workflow } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
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
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Runs' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.5 Commit 27: Runs index — every generation job, newest
 * first, as a dense sortable table.
 *
 * The nav link `/runs` used to 404; the only reachable run URL was
 * `/runs/[id]` after clicking into it from a concept. This gives it
 * a proper landing page so the command palette + rail nav point to
 * something meaningful.
 */
export default async function RunsPage() {
  const { userId } = await requireOnboardingComplete();
  const db = getDb();

  const jobs = await db.query.generationJobs.findMany({
    where: eq(schema.generationJobs.userId, userId),
    columns: {
      id: true,
      status: true,
      requestedAt: true,
      completedAt: true,
      variantCount: true,
      generatedCreativeCount: true,
      estimatedCostUsd: true,
      actualCostUsd: true,
      providerChoice: true,
      format: true,
    },
    orderBy: desc(schema.generationJobs.requestedAt),
    limit: 100,
  });

  return (
    <AppShell crumbs={[{ label: 'Runs' }]}>
      <PageHeader
        title="Runs"
        subtitle={`${jobs.length} recent generation ${jobs.length === 1 ? 'job' : 'jobs'}.`}
      />

      {jobs.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No runs yet."
          description="Upload a concept and generate variants — every run lands here."
        />
      ) : (
        <div className="overflow-x-auto rounded-sm border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pipeline</TableHead>
                <TableHead className="text-right">Variants</TableHead>
                <TableHead className="text-right">Cost est</TableHead>
                <TableHead className="text-right">Cost actual</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead>Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <Link
                      href={`/runs/${j.id}`}
                      className="text-fg font-mono text-xs hover:text-[color:var(--accent-amber)]"
                    >
                      {j.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={jobStatusVariant(j.status)}>{j.status}</Badge>
                  </TableCell>
                  <TableCell className="text-fg-muted font-mono text-xs">
                    {j.providerChoice ?? j.format ?? '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {j.generatedCreativeCount}
                    {j.variantCount ? (
                      <span className="text-fg-subtle"> / {j.variantCount}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-fg-muted text-right font-mono text-xs">
                    {j.estimatedCostUsd != null ? `$${Number(j.estimatedCostUsd).toFixed(3)}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {j.actualCostUsd != null ? `$${Number(j.actualCostUsd).toFixed(3)}` : '—'}
                  </TableCell>
                  <TableCell className="text-fg-muted font-mono text-xs">
                    {formatDateTime(j.requestedAt)}
                  </TableCell>
                  <TableCell className="text-fg-muted font-mono text-xs">
                    {j.completedAt ? formatDateTime(j.completedAt) : '—'}
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

function jobStatusVariant(status: string): BadgeVariant {
  if (status === 'completed') return 'success';
  if (status === 'processing' || status === 'queued') return 'warning';
  if (status === 'failed' || status === 'cancelled') return 'destructive';
  return 'outline';
}
