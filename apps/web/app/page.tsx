import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <main className="container mx-auto flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-16">
      <div className="max-w-2xl text-center">
        <h1 className="text-5xl font-bold tracking-tight">Media Buying Bot</h1>
        <p className="text-muted-foreground mt-4 text-lg">
          Auto-generate, launch, kill, and scale Meta ad creative on autopilot. For performance
          marketers running aggressive verticals.
        </p>
        <p className="text-muted-foreground mt-2 text-sm">
          Free during MVP. Founding members only.
        </p>
      </div>

      <div className="flex gap-3">
        <Link href="/signup">
          <Button size="lg">Get started</Button>
        </Link>
        <Link href="/login">
          <Button size="lg" variant="outline">
            Log in
          </Button>
        </Link>
      </div>

      <p className="text-muted-foreground mt-8 max-w-xl text-center text-xs">
        Use of this platform involves real risk of Meta enforcement against your ad accounts. Review
        the{' '}
        <Link href="/legal/tos" className="underline">
          Terms of Service
        </Link>{' '}
        before signing up.
      </p>
    </main>
  );
}
