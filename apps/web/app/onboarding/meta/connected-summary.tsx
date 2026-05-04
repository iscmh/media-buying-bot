import { formatDate } from '@/lib/format/date';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface Props {
  businessManagerId: string;
  adAccountIds: string[];
  tokenExpiresAt: Date | null;
}

/**
 * Sub-state (c): user has already completed Meta connection. Show a summary
 * card. Disconnect/re-pick is a Phase 2b "settings" feature; for now we
 * surface a tooltip-style note.
 */
export function MetaConnectedSummary({ businessManagerId, adAccountIds, tokenExpiresAt }: Props) {
  const expiry = tokenExpiresAt ? formatDate(tokenExpiresAt) : 'never';

  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Meta is connected</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          You can revisit this step any time. Disconnecting a token is in settings (coming in Phase
          2b).
        </p>
      </header>

      <div className="bg-card space-y-3 rounded-lg border p-6 text-sm">
        <Row
          label="Business Manager ID"
          value={<code className="font-mono">{businessManagerId}</code>}
        />
        <Row label="Managed ad accounts" value={`${adAccountIds.length}`} />
        <Row
          label="Ad account IDs"
          value={
            <ul className="space-y-0.5 font-mono text-xs">
              {adAccountIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          }
        />
        <Row label="Token expires" value={expiry} />
      </div>

      <div className="mt-6 flex justify-end">
        <Button asChild size="lg">
          <Link href="/onboarding/telegram">Continue</Link>
        </Button>
      </div>
    </article>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="text-muted-foreground sm:w-44">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
