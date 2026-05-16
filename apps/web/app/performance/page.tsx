import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Performance — Ads Bot' };

export default async function PerformancePage() {
  await requireOnboardingComplete();

  return (
    <AppShell crumbs={[{ label: 'Performance' }]}>
      <h1 className="text-fg mb-6 text-2xl font-semibold tracking-tight">Performance</h1>
      <Card>
        <CardHeader>
          <CardTitle>Daily P&amp;L</CardTitle>
          <CardDescription>
            Spend, revenue, profit, ROI, CPA, top performers, kill/survive logs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-fg-muted text-sm">Phase 6 — coming soon.</p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
