import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Performance — Media Buying Bot' };

export default async function PerformancePage() {
  await requireOnboardingComplete();

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
