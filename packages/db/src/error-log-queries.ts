import { and, desc, eq, gte, ilike, inArray, sql } from 'drizzle-orm';
import { getDb } from './client';
import { errorLog } from './schema/error-log';
import { users } from './schema/users';

/**
 * Polish-25.7 Commit 46: read-side helpers for /admin/errors.
 *
 * Two shapes:
 *   - listRecentErrors: flat list, most recent first, paginated.
 *   - listGroupedErrors: dedup by fingerprint, show first_seen /
 *     last_seen / count / affected_users_count.
 *
 * Both accept the same filter object so the admin page can flip
 * views without reshaping state.
 */

export type ErrorRangeKey = '1h' | '24h' | '7d' | '30d' | 'all';

export interface ErrorFilters {
  range?: ErrorRangeKey;
  sources?: string[];
  severity?: string;
  userEmail?: string;
  search?: string;
}

export interface RecentErrorRow {
  id: string;
  userId: string | null;
  userEmail: string | null;
  source: string;
  sourceName: string | null;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  breadcrumbs: Array<Record<string, unknown>>;
  severity: string;
  fingerprint: string | null;
  createdAt: Date;
}

export interface GroupedErrorRow {
  fingerprint: string;
  source: string;
  sourceName: string | null;
  sampleMessage: string;
  count: number;
  affectedUsers: number;
  firstSeen: Date;
  lastSeen: Date;
  severity: string;
}

function rangeToDate(range: ErrorRangeKey | undefined): Date | null {
  const now = Date.now();
  switch (range) {
    case '1h':
      return new Date(now - 60 * 60 * 1000);
    case '24h':
      return new Date(now - 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case 'all':
    default:
      return null;
  }
}

function buildWhere(filters: ErrorFilters) {
  const clauses = [] as ReturnType<typeof eq>[];
  const after = rangeToDate(filters.range);
  if (after) clauses.push(gte(errorLog.createdAt, after));
  if (filters.sources && filters.sources.length > 0) {
    clauses.push(inArray(errorLog.source, filters.sources));
  }
  if (filters.severity) clauses.push(eq(errorLog.severity, filters.severity));
  if (filters.search) {
    clauses.push(ilike(errorLog.message, `%${filters.search}%`));
  }
  return clauses.length > 0 ? and(...clauses) : undefined;
}

export async function listRecentErrors(
  filters: ErrorFilters,
  pagination: { limit: number; offset: number },
): Promise<{ rows: RecentErrorRow[]; hasMore: boolean }> {
  const db = getDb();
  const whereClause = buildWhere(filters);

  // Join to users for email display. left join so anonymous rows
  // (user_id null) still surface.
  const rows = await db
    .select({
      id: errorLog.id,
      userId: errorLog.userId,
      userEmail: users.email,
      source: errorLog.source,
      sourceName: errorLog.sourceName,
      message: errorLog.message,
      stack: errorLog.stack,
      context: errorLog.context,
      breadcrumbs: errorLog.breadcrumbs,
      severity: errorLog.severity,
      fingerprint: errorLog.fingerprint,
      createdAt: errorLog.createdAt,
    })
    .from(errorLog)
    .leftJoin(users, eq(users.id, errorLog.userId))
    .where(
      filters.userEmail
        ? and(whereClause, ilike(users.email, `%${filters.userEmail}%`))
        : whereClause,
    )
    .orderBy(desc(errorLog.createdAt))
    .limit(pagination.limit + 1)
    .offset(pagination.offset);

  const hasMore = rows.length > pagination.limit;
  return {
    rows: (hasMore ? rows.slice(0, pagination.limit) : rows) as RecentErrorRow[],
    hasMore,
  };
}

export async function listGroupedErrors(
  filters: ErrorFilters,
  pagination: { limit: number; offset: number },
): Promise<{ rows: GroupedErrorRow[]; hasMore: boolean }> {
  const db = getDb();
  const whereClause = buildWhere(filters);

  const rows = await db
    .select({
      fingerprint: sql<string>`coalesce(${errorLog.fingerprint}, ${errorLog.id}::text)`.as(
        'fingerprint',
      ),
      source:
        sql<string>`(array_agg(${errorLog.source} order by ${errorLog.createdAt} desc))[1]`.as(
          'source',
        ),
      sourceName:
        sql<string>`(array_agg(${errorLog.sourceName} order by ${errorLog.createdAt} desc))[1]`.as(
          'source_name',
        ),
      sampleMessage:
        sql<string>`(array_agg(${errorLog.message} order by ${errorLog.createdAt} desc))[1]`.as(
          'sample_message',
        ),
      count: sql<number>`count(*)::int`.as('count'),
      affectedUsers: sql<number>`count(distinct ${errorLog.userId})::int`.as('affected_users'),
      firstSeen: sql<Date>`min(${errorLog.createdAt})`.as('first_seen'),
      lastSeen: sql<Date>`max(${errorLog.createdAt})`.as('last_seen'),
      severity:
        sql<string>`(array_agg(${errorLog.severity} order by ${errorLog.createdAt} desc))[1]`.as(
          'severity',
        ),
    })
    .from(errorLog)
    .where(whereClause)
    .groupBy(sql`coalesce(${errorLog.fingerprint}, ${errorLog.id}::text)`)
    .orderBy(sql`max(${errorLog.createdAt}) desc`)
    .limit(pagination.limit + 1)
    .offset(pagination.offset);

  const hasMore = rows.length > pagination.limit;
  return {
    rows: (hasMore ? rows.slice(0, pagination.limit) : rows).map((r) => ({
      fingerprint: r.fingerprint,
      source: r.source,
      sourceName: r.sourceName,
      sampleMessage: r.sampleMessage,
      count: r.count,
      affectedUsers: r.affectedUsers,
      firstSeen: new Date(r.firstSeen),
      lastSeen: new Date(r.lastSeen),
      severity: r.severity,
    })),
    hasMore,
  };
}
