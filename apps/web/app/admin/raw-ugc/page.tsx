import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireAdmin } from '@/lib/admin-gate';
import { RawUgcClient } from './raw-ugc-client';

export const metadata = { title: 'Raw UGC - Admin' };
export const dynamic = 'force-dynamic';

/**
 * Polish-30.0.15 Commit 187: admin-only raw UGC generator rebuilt on
 * HeyGen Avatar IV + Nano Banana Pro.
 *
 * Personal tool for the operator to spin one-off UGC videos for
 * their own ad campaigns without going through the polish28
 * variations pipeline (which generates N personas via Claude
 * batch). Pick persona by hand, write a script, hit generate.
 *
 * Auth: `requireAdmin()` redirects non-admins to /dashboard silently
 * so the route's existence doesn't leak.
 *
 * Requirements: admin must have Gemini + HeyGen BYOK connected
 * at /settings/connections. The polish28 variations pipeline uses
 * these same two keys so if the automated flow works, this does too.
 */
export default async function AdminRawUgcPage() {
  await requireAdmin();
  return (
    <AppShell crumbs={[{ label: 'Admin' }, { label: 'Raw UGC' }]}>
      <PageHeader
        title="Raw UGC generator"
        subtitle="Admin-only. Pick a persona, write a script, hit generate. Avatar IV + Nano Banana Pro."
      />
      <RawUgcClient />
    </AppShell>
  );
}
