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
 *
 * Polish-25.2 Commit 16a: tightened copy. Dropped internal jargon
 * ("MMO", "biz-opp"), softened the "(recommended)" that read as odd
 * without any partner to actually recommend, replaced the stiff
 * disclosure paragraph with a compact italic line. Adds a compact
 * bullet list explaining WHY an agency BM matters — walkthrough
 * finding: users read the page and asked "so… do I need this or
 * not?"
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
        <h1 className="text-3xl font-bold">Should you use an agency ad account?</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Short answer: only if you&apos;re running in a niche Meta flags aggressively (finance,
          weight loss, gambling, dating). Otherwise, connect your own Business Manager and skip
          this.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>What an agency ad account gets you</CardTitle>
          <CardDescription>
            You rent an ad account from a partner agency that has a higher trust score with Meta. If
            Meta bans the account, it&apos;s the agency&apos;s — not your personal Facebook.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ul className="text-muted-foreground list-disc space-y-1 pl-5">
            <li>Bans hit the rented account, not your personal Facebook profile.</li>
            <li>Higher spend limits from day one.</li>
            <li>Costs a small % of ad spend or a flat monthly fee (varies by partner).</li>
          </ul>
          <p className="text-muted-foreground">
            We plan to introduce partner options here. Until then, you can{' '}
            <Link href="/settings/connections?tab=meta" className="underline">
              connect your existing Business Manager
            </Link>{' '}
            from Settings.
          </p>
          <p className="text-muted-foreground text-xs italic">
            We may earn a referral fee from partners in the future. No partner relationships exist
            today.
          </p>
        </CardContent>
      </Card>
    </article>
  );
}
