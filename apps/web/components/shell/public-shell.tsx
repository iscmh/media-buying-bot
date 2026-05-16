import Link from 'next/link';

interface Props {
  children: React.ReactNode;
  /** Hide the wordmark — used by the landing page which renders its own. */
  bare?: boolean;
}

/**
 * Public-routes layout: no sidebar, just a thin top strip with the
 * Ads Bot wordmark linking back to the marketing root. Used by /,
 * /login, /signup, /apply, /waitlist, /billing-required.
 */
export function PublicShell({ children, bare = false }: Props) {
  return (
    <div className="bg-bg flex min-h-screen flex-col">
      {!bare && (
        <header className="flex h-14 items-center px-6">
          <Link href="/" className="text-fg text-base font-bold tracking-tight">
            Ads Bot
          </Link>
        </header>
      )}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
