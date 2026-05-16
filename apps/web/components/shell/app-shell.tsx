import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { Sidebar } from './sidebar';
import { TopBar, type Breadcrumb } from './top-bar';

interface Props {
  /** Breadcrumb chain — last item is the current page. */
  crumbs: Breadcrumb[];
  /** Optional right-aligned action in the top bar. */
  action?: React.ReactNode;
  /** Constrain content width. `max-w-7xl` for list/dashboard, `max-w-4xl` for forms. */
  contentClass?: string;
  children: React.ReactNode;
}

/**
 * The authenticated app shell: sidebar on the left, top bar above the
 * content, page body underneath. Server component — reads the current
 * user + admin flag and seeds the sidebar's collapse state from the
 * `sidebar_collapsed` cookie.
 *
 * Callers wrap their page in <AppShell crumbs={...}>{...}</AppShell>.
 * Public routes (/, /login, /apply, /waitlist, /billing-required) use
 * PublicShell instead — no sidebar.
 */
export async function AppShell({ crumbs, action, contentClass, children }: Props) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Admin flag — drives whether the Admin nav item renders.
  const db = getDb();
  const userRow = await db.query.users.findFirst({
    where: eq(schema.users.id, user.id),
    columns: { role: true },
  });
  const isAdmin = userRow?.role === 'admin';

  const cookieStore = await cookies();
  const initialCollapsed = cookieStore.get('sidebar_collapsed')?.value === '1';

  return (
    <div className="bg-bg flex min-h-screen">
      <Sidebar
        email={user.email ?? 'unknown'}
        isAdmin={isAdmin}
        initialCollapsed={initialCollapsed}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar crumbs={crumbs} action={action} />
        <main className={`mx-auto w-full flex-1 px-6 py-6 ${contentClass ?? 'max-w-7xl'}`}>
          {children}
        </main>
      </div>
    </div>
  );
}
