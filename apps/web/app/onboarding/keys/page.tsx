import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { CheckCircle2 } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
import { TOOL_PROVIDER_META, type ToolProviderName } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingStep } from '@/lib/onboarding-gate';
import { ProviderCard } from '@/app/connections/ai-provider/provider-card';
import { ToolCard } from '@/app/connections/tools/tool-card';

export const metadata = { title: 'Connect keys' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.1 Commit 10a: BYOK step. Third + final onboarding step
 * (after tos + risk). Prompts the user to paste + verify the 3 keys
 * the Polish-25 creative-generation pipeline needs:
 *
 *   - Claude   (tool_connections) — script condenser
 *   - Gemini   (tool_connections) — source vision analysis + avatar
 *                                    thumbnail vision
 *   - MakeUGC  (ai_provider_connections) — video renderer
 *
 * All three must be active for onboarding to be considered complete
 * (see packages/db/src/onboarding.ts). Users can go back to
 * /settings/connections later to add optional providers (heygen,
 * hedra, wavespeed_ai, openai, replicate, elevenlabs) — those aren't
 * required for the Polish-25 default flow.
 */
export default async function OnboardingKeysPage() {
  const { userId } = await requireOnboardingStep('keys');
  const db = getDb();

  // Reuse the same queries the /connections pages do — the ProviderCard
  // + ToolCard components own the paste + verify UX.
  const [toolRows, makeugcRow] = await Promise.all([
    db.query.toolConnections.findMany({
      where: and(
        eq(schema.toolConnections.userId, userId),
        isNull(schema.toolConnections.deletedAt),
        inArray(schema.toolConnections.provider, ['claude', 'gemini']),
      ),
      columns: { provider: true, apiKeyVerifiedAt: true, status: true },
    }),
    db.query.aiProviderConnections.findFirst({
      where: and(
        eq(schema.aiProviderConnections.userId, userId),
        eq(schema.aiProviderConnections.provider, 'makeugc'),
        eq(schema.aiProviderConnections.status, 'active'),
        isNull(schema.aiProviderConnections.deletedAt),
      ),
      columns: { apiKeyVerifiedAt: true, lastVerifiedAt: true, tier: true },
    }),
  ]);
  const toolByProvider = new Map<ToolProviderName, (typeof toolRows)[number]>();
  for (const r of toolRows) toolByProvider.set(r.provider as ToolProviderName, r);
  const claudeConn = toolByProvider.get('claude');
  const geminiConn = toolByProvider.get('gemini');

  const claudeReady = claudeConn?.status === 'active';
  const geminiReady = geminiConn?.status === 'active';
  const makeugcReady = !!makeugcRow;
  const allReady = claudeReady && geminiReady && makeugcReady;
  const readyCount = [claudeReady, geminiReady, makeugcReady].filter(Boolean).length;

  // If a user lands here already complete, they'll be bounced by the
  // requireOnboardingStep helper. Belt-and-suspenders: also short-circuit
  // if allReady + provide the "Continue" button below.
  if (allReady) {
    redirect('/dashboard');
  }

  const claudeMeta = TOOL_PROVIDER_META.claude;
  const geminiMeta = TOOL_PROVIDER_META.gemini;

  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Connect your keys</h1>
        <p className="text-fg-muted mt-2 text-sm leading-relaxed">
          Ads Bot is bring-your-own-key. Paste your API keys for the three services below and
          we&apos;ll verify each one. You&apos;ll be able to generate your first ad the moment all
          three turn green.
        </p>
      </header>

      <div className="border-border-subtle text-fg-muted mb-6 flex items-center justify-between rounded-md border px-4 py-3 text-xs">
        <span>
          <span className="text-fg font-medium">{readyCount} of 3</span> keys connected
        </span>
        {allReady && (
          <span className="flex items-center gap-1.5 text-[color:var(--accent-positive)]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            All required keys verified
          </span>
        )}
      </div>

      <div className="space-y-4">
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
        <ProviderCard
          provider="makeugc"
          connected={
            makeugcRow
              ? {
                  apiKeyVerifiedAt: makeugcRow.apiKeyVerifiedAt,
                  lastVerifiedAt: makeugcRow.lastVerifiedAt,
                  tier: makeugcRow.tier,
                }
              : null
          }
        />
      </div>

      <div className="mt-8 flex items-center justify-between gap-3">
        <p className="text-fg-subtle text-xs">
          Need more providers? Add HeyGen, Hedra, WaveSpeed AI, or others any time from{' '}
          <Link href="/settings/connections" className="text-fg underline-offset-4 hover:underline">
            Settings → Connections
          </Link>
          .
        </p>
        <Button asChild disabled={!allReady} variant={allReady ? 'primary' : 'secondary'}>
          <Link href="/dashboard" aria-disabled={!allReady}>
            {allReady ? 'Continue to dashboard' : 'Connect all 3 to continue'}
          </Link>
        </Button>
      </div>
    </article>
  );
}
