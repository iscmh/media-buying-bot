import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Dashboard — Media Buying Bot' };

export default async function DashboardPage() {
  const user = await requireOnboardingComplete();

  return (
    <main className="container mx-auto px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground text-sm">Welcome, {user.email}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Link href="/connections/meta">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Meta connection</CardTitle>
              <CardDescription>Connect your Business Manager.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Phase 2 — coming soon</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/connections/telegram">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Telegram bot</CardTitle>
              <CardDescription>Receive kill/scale alerts.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Phase 2 — coming soon</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/connections/ai-provider">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">AI UGC provider</CardTitle>
              <CardDescription>Bring your own key.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Phase 2 — coming soon</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/concepts">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Concepts</CardTitle>
              <CardDescription>Upload winning creatives.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Phase 3 — coming soon</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/performance">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Performance</CardTitle>
              <CardDescription>P&amp;L, kill/survive logs.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Phase 6 — coming soon</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/settings">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Settings</CardTitle>
              <CardDescription>Bot config + safety rules.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Phase 2 — coming soon</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </main>
  );
}
