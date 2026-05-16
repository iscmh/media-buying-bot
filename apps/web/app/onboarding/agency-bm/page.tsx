import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Agency BM' };

/**
 * Agency BM partner referral information page. Phase 7 will turn this into
 * the real referral integration. In Phase 2a it's an informational stop
 * users can land on while connecting Meta, so we gate it on auth only —
 * not on completed onboarding.
 *
 * Skips the wizard progress bar via the layout's path-based check.
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
          phase. None today — partner integrations land in Phase 7.
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
            Partners list will populate here once the partner integration ships. For now, you can{' '}
            <Link href="/onboarding/meta" className="underline">
              connect your existing BM
            </Link>{' '}
            and acknowledge the risks during onboarding.
          </p>
        </CardContent>
      </Card>
    </article>
  );
}
