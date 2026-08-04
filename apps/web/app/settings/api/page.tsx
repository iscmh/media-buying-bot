import Link from 'next/link';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { assertApiAccess, listApiKeysForUser } from './actions';
import { ApiKeysClient } from './keys-client';

export const metadata = { title: 'API keys' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.10 Commit 59: /settings/api — Scale-tier feature preview.
 * Gate today = admin OR founding member. When billing lands the OR
 * arm becomes plan_tier='scale' too (see actions.ts TODO).
 */
export default async function ApiKeysPage() {
  await requireOnboardingComplete();
  const gate = await assertApiAccess();

  if (!gate.hasAccess) {
    return (
      <AppShell
        crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'API keys' }]}
        contentClass="max-w-3xl"
      >
        <PageHeader
          title="API keys"
          subtitle="Programmatic access to your creative pipeline. Available on the Scale tier."
        />
        <Card>
          <CardHeader>
            <CardTitle>Scale tier — coming soon</CardTitle>
          </CardHeader>
          <CardContent className="text-fg-muted space-y-3 text-sm">
            <p>
              The public API lets you script uploads, generation, approval, and Meta launch from
              your own tools without touching the web UI.
            </p>
            <p>It ships with the Scale tier. For now: available to admins and founding members.</p>
            <p>
              Curious what it exposes?{' '}
              <Link className="text-fg underline" href="/api/v1/docs">
                Read the API docs.
              </Link>
            </p>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const keys = await listApiKeysForUser(gate.userId);

  return (
    <AppShell
      crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'API keys' }]}
      contentClass="max-w-3xl"
    >
      <PageHeader
        title="API keys"
        subtitle="Bearer tokens for /api/v1. Each token has full account access — treat like a password."
      />
      <div className="text-fg-muted text-sm">
        Read the{' '}
        <Link className="text-fg underline" href="/api/v1/docs">
          API docs
        </Link>{' '}
        for the endpoints and examples.
      </div>
      <div className="mt-4">
        <ApiKeysClient initial={keys} />
      </div>
    </AppShell>
  );
}
