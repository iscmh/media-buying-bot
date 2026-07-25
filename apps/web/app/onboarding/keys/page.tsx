import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { CheckCircle2 } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
import { TOOL_PROVIDER_META, type ToolProviderName } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingStep } from '@/lib/onboarding-gate';
import { ToolCard } from '@/app/connections/tools/tool-card';

export const metadata = { title: 'Connect keys' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.1 Commit 10a: BYOK step. Third + final onboarding step
 * (after tos + risk).
 *
 * Polish-25.2 Commit 11: prompts for the TWO remaining BYOK keys —
 * MakeUGC (rebranded "Instant UGC" in the UI) is now platform-
 * managed. Instant UGC video generation uses a shared operator-run
 * MakeUGC subscription pool; users never paste a MakeUGC key.
 *
 *   - Claude   (tool_connections) — script condenser
 *   - Gemini   (tool_connections) — source vision analysis + avatar
 *                                    thumbnail vision
 *
 * Both must be active for onboarding to be considered complete
 * (see packages/db/src/onboarding.ts). Users can go back to
 * /settings/connections later to add optional providers (heygen,
 * hedra, wavespeed_ai, openai, replicate, elevenlabs) — those aren't
 * required for the Instant UGC default flow.
 */
export default async function OnboardingKeysPage() {
  const { userId } = await requireOnboardingStep('keys');
  const db = getDb();

  const toolRows = await db.query.toolConnections.findMany({
    where: and(
      eq(schema.toolConnections.userId, userId),
      isNull(schema.toolConnections.deletedAt),
      inArray(schema.toolConnections.provider, ['claude', 'gemini']),
    ),
    columns: { provider: true, apiKeyVerifiedAt: true, status: true },
  });
  const toolByProvider = new Map<ToolProviderName, (typeof toolRows)[number]>();
  for (const r of toolRows) toolByProvider.set(r.provider as ToolProviderName, r);
  const claudeConn = toolByProvider.get('claude');
  const geminiConn = toolByProvider.get('gemini');

  const claudeReady = claudeConn?.status === 'active';
  const geminiReady = geminiConn?.status === 'active';
  const allReady = claudeReady && geminiReady;
  const readyCount = [claudeReady, geminiReady].filter(Boolean).length;

  // If a user lands here already complete, they'll be bounced by the
  // requireOnboardingStep helper. Belt-and-suspenders: also short-circuit
  // if allReady + provide the "Continue" button below.
  if (allReady) {
    redirect('/dashboard');
  }

  const claudeMeta = TOOL_PROVIDER_META.claude;
  const geminiMeta = TOOL_PROVIDER_META.gemini;

  return (
    // Polish-25.2 Commit 17: visual polish. Prior version felt
    // cheap next to /settings/connections' Providers tab despite
    // using the same ToolCard component — the wrapper was flat +
    // token-mismatched. Changes:
    //   - Wider max-w so cards breathe like Settings' cards
    //   - Progress indicator moved to a bespoke "step X of Y"
    //     header row that reads intentional instead of dashed
    //   - Section heading over the card list ("Required to
    //     continue") in the same treatment Providers tab uses
    //   - Sticky-ish footer with the continue CTA + a right-
    //     aligned secondary "add more later" link (was a stacked
    //     row previously — read as a footnote)
    <article className="mx-auto max-w-3xl px-4 pb-24 pt-6 sm:pt-10">
      <header className="mb-8">
        <p className="text-fg-subtle mb-2 text-[11px] font-semibold uppercase tracking-[0.15em]">
          Step 3 of 3
        </p>
        <h1 className="text-fg text-3xl font-bold tracking-tight">Connect your keys</h1>
        <p className="text-fg-muted mt-2 max-w-prose text-sm leading-relaxed">
          Ads Bot is bring-your-own-key for Claude and Gemini. Paste an API key for each and
          we&apos;ll verify it on the spot. Instant UGC video generation is included on the platform
          — no extra key needed.
        </p>
      </header>

      <div className="border-border-subtle bg-bg-surface mb-6 flex items-center justify-between rounded-md border px-4 py-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="border-fg/25 text-fg flex h-6 min-w-[3rem] items-center justify-center rounded-full border px-2 font-mono text-xs font-semibold">
            {readyCount} / 2
          </span>
          <span className="text-fg-muted">
            {allReady ? 'All required keys verified.' : 'Required keys connected'}
          </span>
        </div>
        {allReady && (
          <span className="flex items-center gap-1.5 text-xs text-[color:var(--accent-positive)]">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Ready
          </span>
        )}
      </div>

      <section>
        <h2 className="text-fg-subtle mb-3 text-xs font-semibold uppercase tracking-wider">
          Required to continue
        </h2>
        <div className="space-y-3">
          <ToolCard
            provider="claude"
            label={claudeMeta.label}
            role={claudeMeta.role}
            description={claudeMeta.description}
            apiDocsUrl={claudeMeta.apiDocsUrl}
            keyHint={claudeMeta.keyHint}
            connected={claudeReady}
            verifiedDisplay={claudeConn ? formatDateTime(claudeConn.apiKeyVerifiedAt) : null}
          />
          <ToolCard
            provider="gemini"
            label={geminiMeta.label}
            role={geminiMeta.role}
            description={geminiMeta.description}
            apiDocsUrl={geminiMeta.apiDocsUrl}
            keyHint={geminiMeta.keyHint}
            connected={geminiReady}
            verifiedDisplay={geminiConn ? formatDateTime(geminiConn.apiKeyVerifiedAt) : null}
          />
        </div>
      </section>

      <div className="border-border-subtle mt-10 flex flex-col items-start justify-between gap-4 border-t pt-6 sm:flex-row sm:items-center">
        <p className="text-fg-subtle text-xs">
          Need alternate pipelines? Add HeyGen, Hedra, WaveSpeed AI, or others any time from{' '}
          <Link
            href="/settings/connections"
            className="text-fg-muted hover:text-fg underline-offset-4 hover:underline"
          >
            Settings → Connections
          </Link>
          .
        </p>
        <Button
          asChild
          size="lg"
          disabled={!allReady}
          variant={allReady ? 'accent' : 'secondary'}
          className="w-full sm:w-auto"
        >
          <Link href="/dashboard" aria-disabled={!allReady}>
            {allReady ? 'Continue to dashboard' : 'Connect both to continue'}
          </Link>
        </Button>
      </div>
    </article>
  );
}
