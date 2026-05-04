import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Settings — Media Buying Bot' };

export default async function SettingsPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <main className="container mx-auto px-4 py-12">
      <h1 className="mb-6 text-3xl font-bold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Bot configuration</CardTitle>
          <CardDescription>
            Test caps, kill thresholds, scale tiers, manual approval cutoffs, timezone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Settings UI ships in Phase 2. Defaults are seeded automatically via the
            <code className="bg-muted mx-1 rounded px-1 py-0.5">user_settings</code> trigger.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
