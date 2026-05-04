import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { getDb, getLatestPauseReason, schema } from '@mbb/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { PauseBanner } from './_components/pause-banner';

export const metadata = { title: 'Dashboard — Media Buying Bot' };

export default async function DashboardPage() {
  const user = await requireOnboardingComplete();

  const db = getDb();
  const userRow = await db.query.users.findFirst({
    where: eq(schema.users.id, user.userId),
    columns: { isPaused: true },
  });
  const pauseReason = userRow?.isPaused ? await getLatestPauseReason(user.userId) : null;

  return (
    <main className="container mx-auto px-4 py-12">
      {pauseReason && (
        <PauseBanner
          reason={pauseReason.reason}
          pausedAt={pauseReason.pausedAt}
          pausedBy={pauseReason.pausedBy}
        />
      )}

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
              <CardDescription>Manage your Business Manager + ad accounts.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">View · Disconnect</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/connections/telegram">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Telegram bot</CardTitle>
              <CardDescription>Where you receive kill/scale alerts.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">View · Disconnect</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/connections/ai-provider">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">AI UGC provider</CardTitle>
              <CardDescription>Arcads · HeyGen · Creatify (BYOK).</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">View · Switch · Disconnect</p>
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
              <CardDescription>Bot config: caps, kill/scale, safety.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Edit</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </main>
  );
}
