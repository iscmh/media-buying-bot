import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Performance — Media Buying Bot' };

export default async function PerformancePage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <main className="container mx-auto px-4 py-12">
      <h1 className="mb-6 text-3xl font-bold">Performance</h1>
      <Card>
        <CardHeader>
          <CardTitle>Daily P&amp;L</CardTitle>
          <CardDescription>
            Spend, revenue, profit, ROI, CPA, top performers, kill/survive logs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Phase 6 — coming soon.</p>
        </CardContent>
      </Card>
    </main>
  );
}
