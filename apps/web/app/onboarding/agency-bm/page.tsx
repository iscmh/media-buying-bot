import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Agency BM — Media Buying Bot' };

/**
 * Agency BM partner referral step. Tracking is wired from day 1; the actual
 * partner deal is signed in Phase 7 (Beta polish) — until then this page
 * shows the placeholder list and records intent in `partner_referrals`.
 */
export default async function AgencyBMPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-2 text-3xl font-bold">Agency Business Manager (recommended)</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Disclosure: We receive referral compensation from agency BM partners. This is
        because aggressive verticals require account separation that protects you and us.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Why an agency BM?</CardTitle>
          <CardDescription>
            Isolates Meta enforcement risk from your personal Facebook account. Recommended
            for MMO, bizopp, and finance verticals.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Partners list will populate here once we&rsquo;ve signed our first deal (Phase 7).
            For now, you can{' '}
            <Link href="/connections/meta" className="underline">
              connect your existing BM
            </Link>{' '}
            and acknowledge the risks.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
