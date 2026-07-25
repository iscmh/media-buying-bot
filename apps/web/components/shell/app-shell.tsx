import { redirect } from 'next/navigation';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { IconRail } from './icon-rail';
import { TopToolbar, type Breadcrumb } from './top-toolbar';

interface Props {
  /** Breadcrumb chain — last item is the current page. */
  crumbs: Breadcrumb[];
  /** Optional right-aligned action in the top bar. */
  action?: React.ReactNode;
  /**
   * Optional content-width override. Polish-25.5 Commit 27: default is
   * now `max-w-none` (edge-to-edge) so data pages fill the canvas.
   * Form pages that want the old centered narrow column pass
   * `max-w-2xl` / `max-w-3xl` / `max-w-4xl` explicitly.
   */
  contentClass?: string;
  children: React.ReactNode;
}

/**
 * Polish-25.5 Commit 27: full Trader Terminal shell.
 *
 * Left = 48px icon rail (always icon-only, hover-flyout labels,
 *   Datadog pattern).
 * Top = 40px toolbar with breadcrumbs + Cmd+K palette launcher +
 *   optional page action + avatar-triggered account menu.
 * Content = edge-to-edge canvas by default; form pages opt into
 *   narrow centered widths via contentClass.
 *
 * Server component: fetches the current user + the recent items
 * feeding the command palette (last 30 concepts / jobs / launched
 * ads) in a single Promise.all round-trip.
 */
export async function AppShell({ crumbs, action, contentClass, children }: Props) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const db = getDb();

  // Fetch everything the shell needs in one round-trip: role, launched-ad
  // existence (to decide whether to show the Launched nav item), and the
  // recent-items lists that feed the command palette.
  const [userRow, launchedRow, recentConceptsRaw, recentJobsRaw, recentLaunchedRaw] =
    await Promise.all([
      db.query.users.findFirst({
        where: eq(schema.users.id, user.id),
        columns: { role: true },
      }),
      db.query.launchedAds.findFirst({
        where: and(
          eq(schema.launchedAds.userId, user.id),
          ne(schema.launchedAds.status, 'launch_failed'),
        ),
        columns: { id: true },
      }),
      db.query.concepts.findMany({
        where: and(eq(schema.concepts.userId, user.id), isNull(schema.concepts.deletedAt)),
        columns: { id: true, name: true, createdAt: true },
        orderBy: (t, { desc: d }) => [d(t.createdAt)],
        limit: 30,
      }),
      db.query.generationJobs.findMany({
        where: eq(schema.generationJobs.userId, user.id),
        columns: { id: true, status: true, requestedAt: true },
        orderBy: (t, { desc: d }) => [d(t.requestedAt)],
        limit: 30,
      }),
      db
        .select({
          id: schema.launchedAds.id,
          status: schema.launchedAds.status,
          launchedAt: schema.launchedAds.launchedAt,
          generationJobId: schema.launchedAds.generationJobId,
          headline: schema.generatedCreatives.headline,
        })
        .from(schema.launchedAds)
        .leftJoin(
          schema.generatedCreatives,
          eq(schema.launchedAds.generatedCreativeId, schema.generatedCreatives.id),
        )
        .where(eq(schema.launchedAds.userId, user.id))
        .orderBy(desc(schema.launchedAds.launchedAt))
        .limit(30),
    ]);

  const isAdmin = userRow?.role === 'admin';
  const showLaunched = !!launchedRow;

  const recentConcepts = recentConceptsRaw.map((c) => ({
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
  }));
  const recentJobs = recentJobsRaw.map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.requestedAt,
  }));
  const recentLaunched = recentLaunchedRaw.map((l) => ({
    id: l.id,
    headline: l.headline,
    status: l.status,
    launchedAt: l.launchedAt,
    generationJobId: l.generationJobId,
  }));

  return (
    <div className="bg-bg flex min-h-screen">
      <IconRail showLaunched={showLaunched} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopToolbar
          crumbs={crumbs}
          action={action}
          email={user.email ?? 'unknown'}
          isAdmin={isAdmin}
          showLaunched={showLaunched}
          recentConcepts={recentConcepts}
          recentJobs={recentJobs}
          recentLaunched={recentLaunched}
        />
        <main
          className={
            contentClass
              ? `mx-auto w-full flex-1 px-4 py-4 sm:px-6 sm:py-5 ${contentClass}`
              : 'w-full flex-1 px-4 py-4 sm:px-6 sm:py-5'
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
