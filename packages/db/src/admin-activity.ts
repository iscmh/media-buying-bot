import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { getDb } from './client';
import { concepts } from './schema/concepts';
import { metaConnections, toolConnections } from './schema/connections';
import { generationJobs } from './schema/generation';
import { launchedAds } from './schema/launched-ads';
import { userPauseLog } from './schema/ops';
import { users } from './schema/users';

/**
 * Polish-25.7 Commit 44: read-only admin activity summary.
 *
 * One row per user with rolled-up counts (concepts / generations / launched
 * ads), current bot state, connection status, and last-activity timestamp.
 * Sourced with a handful of separate queries and merged in-process rather
 * than a single fat SQL join — beta cohort is <100 users, so N small
 * queries with clean indexes is fine and the code stays readable.
 *
 * Excludes soft-deleted users. `last_activity_at` = max of the row's own
 * updated_at across concepts / generation_jobs / launched_ads, so admins
 * can see who's been quiet for a week.
 */

export interface AdminActivityRow {
  userId: string;
  email: string;
  role: 'user' | 'admin';
  signupAt: Date;
  isPaused: boolean;
  pauseReason: string | null;
  pauseCount: number;
  metaConnected: boolean;
  toolClaudeConnected: boolean;
  toolGeminiConnected: boolean;
  conceptsTotal: number;
  generationsTotal: number;
  generationsFailed7d: number;
  generationsSucceeded7d: number;
  launchedTotal: number;
  launchedActive: number;
  launchedRejected7d: number;
  lastActivityAt: Date | null;
}

export async function getAdminActivityRows(): Promise<AdminActivityRow[]> {
  const db = getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    userRows,
    pauseRows,
    metaRows,
    toolRows,
    conceptCounts,
    genCounts,
    genRecent,
    launchedCounts,
    launchedRecent,
    lastActivity,
  ] = await Promise.all([
    db.query.users.findMany({
      where: isNull(users.deletedAt),
      columns: {
        id: true,
        email: true,
        role: true,
        isPaused: true,
        createdAt: true,
      },
    }),
    db
      .select({
        userId: userPauseLog.userId,
        reason: sql<string>`(array_agg(${userPauseLog.reason} order by ${userPauseLog.pausedAt} desc))[1]`,
        count: sql<number>`count(*)::int`,
      })
      .from(userPauseLog)
      .where(isNull(userPauseLog.unpausedAt))
      .groupBy(userPauseLog.userId),
    db
      .select({ userId: metaConnections.userId })
      .from(metaConnections)
      .where(and(eq(metaConnections.status, 'active'), isNull(metaConnections.deletedAt))),
    db
      .select({ userId: toolConnections.userId, provider: toolConnections.provider })
      .from(toolConnections)
      .where(and(eq(toolConnections.status, 'active'), isNull(toolConnections.deletedAt))),
    db
      .select({ userId: concepts.userId, total: sql<number>`count(*)::int` })
      .from(concepts)
      .where(isNull(concepts.deletedAt))
      .groupBy(concepts.userId),
    db
      .select({ userId: generationJobs.userId, total: sql<number>`count(*)::int` })
      .from(generationJobs)
      .groupBy(generationJobs.userId),
    db
      .select({
        userId: generationJobs.userId,
        failed: sql<number>`count(*) filter (where ${generationJobs.status} = 'failed')::int`,
        succeeded: sql<number>`count(*) filter (where ${generationJobs.status} = 'completed')::int`,
      })
      .from(generationJobs)
      .where(gte(generationJobs.updatedAt, sevenDaysAgo))
      .groupBy(generationJobs.userId),
    db
      .select({
        userId: launchedAds.userId,
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${launchedAds.status} = 'active')::int`,
      })
      .from(launchedAds)
      .groupBy(launchedAds.userId),
    db
      .select({
        userId: launchedAds.userId,
        rejected: sql<number>`count(*) filter (where ${launchedAds.status} in ('rejected_by_meta','launch_failed'))::int`,
      })
      .from(launchedAds)
      .where(gte(launchedAds.updatedAt, sevenDaysAgo))
      .groupBy(launchedAds.userId),
    db
      .select({
        userId: users.id,
        lastAt: sql<Date | null>`greatest(
          coalesce(max(${concepts.updatedAt}), 'epoch'::timestamptz),
          coalesce(max(${generationJobs.updatedAt}), 'epoch'::timestamptz),
          coalesce(max(${launchedAds.updatedAt}), 'epoch'::timestamptz)
        )`,
      })
      .from(users)
      .leftJoin(concepts, eq(concepts.userId, users.id))
      .leftJoin(generationJobs, eq(generationJobs.userId, users.id))
      .leftJoin(launchedAds, eq(launchedAds.userId, users.id))
      .groupBy(users.id),
  ]);

  const pauseByUser = new Map(pauseRows.map((r) => [r.userId, r]));
  const metaByUser = new Set(metaRows.map((r) => r.userId));
  const toolByUser = new Map<string, Set<string>>();
  for (const r of toolRows) {
    if (!toolByUser.has(r.userId)) toolByUser.set(r.userId, new Set());
    toolByUser.get(r.userId)!.add(r.provider);
  }
  const conceptByUser = new Map(conceptCounts.map((r) => [r.userId, r.total]));
  const genTotalByUser = new Map(genCounts.map((r) => [r.userId, r.total]));
  const genRecentByUser = new Map(genRecent.map((r) => [r.userId, r]));
  const launchedByUser = new Map(launchedCounts.map((r) => [r.userId, r]));
  const launchedRecentByUser = new Map(launchedRecent.map((r) => [r.userId, r.rejected]));
  const lastActivityByUser = new Map(lastActivity.map((r) => [r.userId, r.lastAt]));

  return userRows.map((u) => {
    const p = pauseByUser.get(u.id);
    const tools = toolByUser.get(u.id) ?? new Set();
    const genR = genRecentByUser.get(u.id);
    const la = launchedByUser.get(u.id);
    // greatest() emits epoch if all sources are NULL; treat that as "never".
    const rawLast = lastActivityByUser.get(u.id);
    const last = rawLast && new Date(rawLast).getTime() > 0 ? new Date(rawLast) : null;
    return {
      userId: u.id,
      email: u.email,
      role: u.role,
      signupAt: u.createdAt,
      isPaused: u.isPaused,
      pauseReason: p?.reason ?? null,
      pauseCount: p?.count ?? 0,
      metaConnected: metaByUser.has(u.id),
      toolClaudeConnected: tools.has('claude'),
      toolGeminiConnected: tools.has('gemini'),
      conceptsTotal: conceptByUser.get(u.id) ?? 0,
      generationsTotal: genTotalByUser.get(u.id) ?? 0,
      generationsFailed7d: genR?.failed ?? 0,
      generationsSucceeded7d: genR?.succeeded ?? 0,
      launchedTotal: la?.total ?? 0,
      launchedActive: la?.active ?? 0,
      launchedRejected7d: launchedRecentByUser.get(u.id) ?? 0,
      lastActivityAt: last,
    };
  });
}
