import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Meta connection — Media Buying Bot' };

export default async function ConnectMetaPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-2 text-3xl font-bold">Connect Meta</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        We use your own Meta Developer App + long-lived access token (BYO). This skips
        Meta&rsquo;s 4–12 week App Review and isolates rate limits + liability to your account.
      </p>

      <Card className="mb-6 border-destructive/50">
        <CardHeader>
          <CardTitle className="text-base">Risk acknowledgment</CardTitle>
          <CardDescription>
            Meta enforcement is aggressive in MMO/bizopp/finance. Cascading suspensions can
            affect your personal Facebook account. Strongly consider an agency BM via our{' '}
            <Link href="/onboarding/agency-bm" className="underline">
              partner
            </Link>{' '}
            before connecting your existing BM to aggressive verticals.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Token onboarding wizard</CardTitle>
          <CardDescription>
            Step-by-step instructions for creating your Meta app, generating a long-lived token,
            and pasting it here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Phase 2 — coming soon.</p>
        </CardContent>
      </Card>
    </main>
  );
}
