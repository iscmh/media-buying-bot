import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <div className="bg-bg flex min-h-screen flex-col">
      <header className="flex h-14 items-center px-6">
        <Link href="/" className="text-fg text-base font-bold tracking-tight">
          Ads Bot
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center">
        <div className="animate-slide-up space-y-4">
          <h1 className="text-fg text-5xl font-bold tracking-tight md:text-6xl">Ads Bot</h1>
          <p className="text-fg-muted mx-auto max-w-xl text-lg leading-relaxed">
            Auto-generate, launch, kill, and scale Meta ad creative on autopilot. For performance
            marketers running aggressive verticals.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/apply">Get started</Link>
          </Button>
          <Button asChild size="lg" variant="ghost">
            <Link href="/login">Log in</Link>
          </Button>
        </div>

        <p className="text-fg-subtle max-w-xl text-xs leading-relaxed">
          Use of this platform involves real risk of Meta enforcement against your ad accounts.
          Review the{' '}
          <Link href="/legal/tos" className="hover:text-fg underline transition-colors">
            Terms of Service
          </Link>{' '}
          before signing up.
        </p>
      </main>

      <footer className="text-fg-subtle flex h-12 items-center justify-between px-6 text-xs">
        <span>© {new Date().getFullYear()} Ads Bot</span>
        <div className="flex items-center gap-4">
          <Link href="/legal/tos" className="hover:text-fg transition-colors">
            Terms
          </Link>
          <Link href="/legal/privacy" className="hover:text-fg transition-colors">
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
