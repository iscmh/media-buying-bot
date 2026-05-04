import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'AI provider — Media Buying Bot' };

export default async function ConnectAIProviderPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-6 text-3xl font-bold">AI UGC provider</h1>
      <p className="text-muted-foreground mb-4 text-sm">
        Pick one: Arcads (recommended), HeyGen, or Creatify. Bring your own API key.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Provider selection + key paste</CardTitle>
          <CardDescription>
            You can switch providers in Settings without re-uploading concepts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Phase 2 — coming soon.</p>
        </CardContent>
      </Card>
    </main>
  );
}
