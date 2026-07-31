import { listGroupedErrors, listRecentErrors, type ErrorRangeKey } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireAdmin } from '@/lib/admin-gate';
import { ErrorsClient, type SerializedGroupedRow, type SerializedRecentRow } from './errors-client';

export const metadata = { title: 'Errors - Admin' };
export const dynamic = 'force-dynamic';

const VALID_RANGES: ErrorRangeKey[] = ['1h', '24h', '7d', '30d', 'all'];
const VALID_VIEWS = ['recent', 'grouped'] as const;
const VALID_SOURCES = [
  'server_action',
  'api_route',
  'worker',
  'client_render',
  'client_boundary',
  'unhandled_promise',
];
const PAGE_SIZE = 50;

interface Props {
  searchParams: Promise<{
    view?: string;
    range?: string;
    sources?: string;
    severity?: string;
    email?: string;
    q?: string;
    page?: string;
  }>;
}

/**
 * Polish-25.7 Commit 46: admin-only error stream + grouped view.
 *
 * requireAdmin() silently redirects non-admins to /dashboard so the
 * route's existence doesn't leak. All filter/sort state lives in
 * URL search params so admins can share links.
 */
export default async function AdminErrorsPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const view = VALID_VIEWS.includes(sp.view as (typeof VALID_VIEWS)[number])
    ? (sp.view as (typeof VALID_VIEWS)[number])
    : 'recent';
  const range: ErrorRangeKey = VALID_RANGES.includes(sp.range as ErrorRangeKey)
    ? (sp.range as ErrorRangeKey)
    : '24h';
  const sources = (sp.sources ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => VALID_SOURCES.includes(s));
  const severity = sp.severity ?? undefined;
  const userEmail = sp.email ?? undefined;
  const search = sp.q ?? undefined;
  const page = Math.max(1, Number(sp.page ?? '1') || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const filters = { range, sources, severity, userEmail, search };

  let recent: { rows: SerializedRecentRow[]; hasMore: boolean } = { rows: [], hasMore: false };
  let grouped: { rows: SerializedGroupedRow[]; hasMore: boolean } = { rows: [], hasMore: false };

  if (view === 'recent') {
    const result = await listRecentErrors(filters, { limit: PAGE_SIZE, offset });
    recent = {
      hasMore: result.hasMore,
      rows: result.rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  } else {
    const result = await listGroupedErrors(filters, { limit: PAGE_SIZE, offset });
    grouped = {
      hasMore: result.hasMore,
      rows: result.rows.map((r) => ({
        ...r,
        firstSeen: r.firstSeen.toISOString(),
        lastSeen: r.lastSeen.toISOString(),
      })),
    };
  }

  return (
    <AppShell crumbs={[{ label: 'Admin' }, { label: 'Errors' }]}>
      <PageHeader
        title="Errors"
        subtitle="First-party error stream. Server actions, API routes, workers, and client boundaries. 90-day retention."
      />
      <ErrorsClient
        view={view}
        range={range}
        sources={sources}
        severity={severity ?? ''}
        userEmail={userEmail ?? ''}
        search={search ?? ''}
        page={page}
        pageSize={PAGE_SIZE}
        recent={recent}
        grouped={grouped}
      />
    </AppShell>
  );
}
