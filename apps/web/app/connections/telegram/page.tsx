import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Telegram bot — Media Buying Bot' };

export default async function ConnectTelegramPage() {
  await requireOnboardingComplete();

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-6 text-3xl font-bold">Connect Telegram</h1>
      <Card>
        <CardHeader>
          <CardTitle>Link your Telegram account</CardTitle>
          <CardDescription>
            We&rsquo;ll generate a one-time code. Open the bot and send{' '}
            <code>/start &lt;code&gt;</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Phase 2 — coming soon.</p>
        </CardContent>
      </Card>
    </main>
  );
}
