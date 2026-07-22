import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Agency BM' };

/**
 * Agency BM partner referral information page. Informational stop
 * users can land on while connecting Meta. Auth-only gate — not
 * gated on completed onboarding.
 *
 * Polish-25.2 Commit 12: user-facing copy rewritten to remove
 * internal phase references. Partner integration timing is neutral
 * ("a future update") rather than "Phase 7".
 */
export default async function AgencyBMPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Agency Business Manager (recommended)</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Disclosure: We may receive referral compensation from agency BM partners in a future
          update. No such relationships exist today.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Why an agency BM?</CardTitle>
          <CardDescription>
            Isolates Meta enforcement risk from your personal Facebook account. Strongly recommended
            for MMO, biz-opp, and finance verticals.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Partner integrations land in a future update. For now, you can{' '}
            <Link href="/settings/connections?tab=meta" className="underline">
              connect your existing Business Manager
            </Link>{' '}
            from Settings when you&apos;re ready.
          </p>
        </CardContent>
      </Card>
    </article>
  );
}
