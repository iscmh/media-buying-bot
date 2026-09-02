import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCreditBalance } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { QuickSeedanceForm } from './quick-seedance-form';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Quick Seedance video' };
export const dynamic = 'force-dynamic';

/**
 * Polish-29.0.7 Commit 116: user-facing Quick Seedance page.
 *
 * A single-prompt Seedance 2.5 video generator that spends credits
 * only — no BYOK keys required. Every paying user with credits can
 * hit this today; the platform routes the request through the
 * shared Dreamina account registered against USEAPI_NET_DEFAULT_
 * DREAMINA_ACCOUNT.
 *
 * When the balance is short, the CostPreviewBadge inside the form
 * flips red with a "top up" hint and the submit button surfaces
 * a specific "Not enough credits — need N, you have M" error
 * pointing at /settings/credits.
 */
export default async function QuickSeedancePage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const balance = await getCreditBalance(user.id);

  return (
    <AppShell
      crumbs={[{ label: 'Generate' }, { label: 'Quick Seedance' }]}
      contentClass="max-w-3xl"
    >
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-fg text-xl font-semibold">Quick Seedance video</h1>
          <p className="text-fg-muted text-sm">
            One prompt → one Seedance 2.5 video. 40 credits per generation. Result appears in{' '}
            <Link href="/runs" className="text-fg underline underline-offset-2">
              Runs
            </Link>{' '}
            as soon as Seedance finishes.
          </p>
        </header>
        <div className="border-border bg-bg-surface rounded-lg border p-4 sm:p-6">
          <QuickSeedanceForm initialBalance={balance.balance} />
        </div>
        <p className="text-fg-muted text-xs">
          Need more credits?{' '}
          <Link href="/settings/credits" className="underline underline-offset-2">
            Top up on the Credits page
          </Link>{' '}
          — packs from $10 for 500 credits.
        </p>
      </div>
    </AppShell>
  );
}
