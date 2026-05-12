import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Launched ads — Media Buying Bot' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface Props {
  searchParams: Promise<{ page?: string }>;
}

export default async function LaunchedAdsPage({ searchParams }: Props) {
  const { userId } = await requireOnboardingComplete();
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? '1') || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = getDb();
  const rows = await db.query.launchedAds.findMany({
    where: eq(schema.launchedAds.userId, userId),
    orderBy: desc(schema.launchedAds.launchedAt),
    limit: PAGE_SIZE + 1,
    offset,
  });

  const hasNextPage = rows.length > PAGE_SIZE;
  const visible = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;

  // Fetch variant copy + thumbnail for each row in one query.
  const creativeIds = visible.map((r) => r.generatedCreativeId);
  const creatives =
    creativeIds.length > 0
      ? await db.query.generatedCreatives.findMany({
          where: (tbl, { inArray }) => inArray(tbl.id, creativeIds),
          columns: { id: true, fileUrl: true, headline: true, primaryText: true },
        })
      : [];
  const creativeById = new Map(creatives.map((c) => [c.id, c]));

  return (
    <main className="container mx-auto max-w-6xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Launched ads</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every ad the bot has pushed to Meta. Phase 4a runs in DRY_RUN — IDs show{' '}
          <code className="font-mono">dry_run_*</code> placeholders and no real money is spent.
        </p>
      </header>

      {visible.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No launches yet</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            Approve variants on a generation job, then click &quot;Launch approved&quot; to push
            them to Meta.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead>Meta IDs</TableHead>
                <TableHead>Daily budget</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Spend (P5)</TableHead>
                <TableHead>Impr / Clicks (P5)</TableHead>
                <TableHead>Launched</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => {
                const creative = creativeById.get(row.generatedCreativeId);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex items-start gap-3">
                        {creative?.fileUrl ? (
                          <Link href={`/jobs/${row.generationJobId ?? ''}`}>
                            <img
                              src={creative.fileUrl}
                              alt={creative.headline ?? 'variant'}
                              className="bg-muted h-16 w-16 rounded object-cover"
                            />
                          </Link>
                        ) : (
                          <div className="bg-muted h-16 w-16 rounded" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {creative?.headline ?? '(no headline)'}
                          </p>
                          <p className="text-muted-foreground line-clamp-2 text-xs">
                            {creative?.primaryText ?? ''}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <div className="space-y-0.5">
                        <p>
                          <span className="text-muted-foreground">camp:</span>{' '}
                          {row.metaCampaignId ?? '—'}
                        </p>
                        <p>
                          <span className="text-muted-foreground">ad:</span> {row.metaAdId ?? '—'}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>${Number(row.dailyBudgetUsd).toFixed(2)}</TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} mode={row.mode} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">—</TableCell>
                    <TableCell className="text-muted-foreground text-xs">—</TableCell>
                    <TableCell className="text-xs">{formatDateTime(row.launchedAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {(page > 1 || hasNextPage) && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          {page > 1 ? (
            <Link
              href={`/launched?page=${page - 1}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground text-xs">Page {page}</span>
          {hasNextPage ? (
            <Link
              href={`/launched?page=${page + 1}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </main>
  );
}

function StatusBadge({ status, mode }: { status: string; mode: string }) {
  const palette: Record<string, string> = {
    dry_run: 'bg-muted text-muted-foreground',
    active: 'bg-green-500/10 text-green-700 border border-green-500/40',
    paused: 'bg-yellow-500/10 text-yellow-700 border border-yellow-500/40',
    killed: 'bg-destructive/10 text-destructive border border-destructive/40',
    rejected_by_meta: 'bg-destructive/10 text-destructive border border-destructive/40',
    launch_failed: 'bg-destructive/10 text-destructive border border-destructive/40',
  };
  const className = `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
    palette[status] ?? 'bg-muted text-muted-foreground'
  }`;
  return (
    <span className={className} title={`mode=${mode}`}>
      {status}
    </span>
  );
}
