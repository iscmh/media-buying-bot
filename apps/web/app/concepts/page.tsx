import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Concepts — Media Buying Bot' };

export default async function ConceptsPage() {
  await requireOnboardingComplete();

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-6 text-3xl font-bold">Concepts</h1>
      <Card>
        <CardHeader>
          <CardTitle>Upload winners</CardTitle>
          <CardDescription>
            Upload 5–6 winning creative concepts (videos or text descriptions). The bot splits hook
            / body / CTA, then mixes 30–40 fresh variants.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Phase 3 — coming soon.</p>
        </CardContent>
      </Card>
    </main>
  );
}
