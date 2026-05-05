import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { getDb, getLatestPauseReason, schema } from '@mbb/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { PauseBanner } from './_components/pause-banner';
import { getConnectionSummaries } from './_lib/connection-summaries';

export const metadata = { title: 'Dashboard — Media Buying Bot' };

export default async function DashboardPage() {
  const user = await requireOnboardingComplete();

  const db = getDb();
  const userRow = await db.query.users.findFirst({
    where: eq(schema.users.id, user.userId),
    columns: { isPaused: true },
  });
  const [pauseReason, summaries] = await Promise.all([
    userRow?.isPaused ? getLatestPauseReason(user.userId) : Promise.resolve(null),
    getConnectionSummaries(user.userId),
  ]);

  return (
    <main className="container mx-auto px-4 py-12">
      {pauseReason && (
        <PauseBanner
          reason={pauseReason.reason}
          pausedAt={pauseReason.pausedAt}
          openPauseCount={pauseReason.openPauseCount}
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
              {summaries.meta.connected ? (
                <p className="text-sm">
                  <span className="font-medium">Connected</span>{' '}
                  <span className="text-muted-foreground">
                    · BM …{summaries.meta.bmIdShort} · {summaries.meta.adAccountCount} ad account
                    {summaries.meta.adAccountCount === 1 ? '' : 's'}
                  </span>
                </p>
              ) : (
                <p className="text-destructive text-sm">Disconnected — reconnect →</p>
              )}
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
              {summaries.telegram.connected ? (
                <p className="text-sm">
                  <span className="font-medium">Linked</span>{' '}
                  {summaries.telegram.username && (
                    <span className="text-muted-foreground font-mono">
                      as @{summaries.telegram.username}
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-destructive text-sm">Disconnected — reconnect →</p>
              )}
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
              {summaries.aiProvider.connected ? (
                <p className="text-sm">
                  <span className="font-medium">{summaries.aiProvider.label}</span>{' '}
                  <span className="text-muted-foreground">connected</span>
                </p>
              ) : (
                <p className="text-destructive text-sm">Not connected — connect provider →</p>
              )}
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
              <CardDescription>Configure bot rules.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Caps · kill/scale · timezone</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </main>
  );
}
