import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface Props {
  /** Where to send the user to reconnect (typically /onboarding/<service>). */
  reconnectHref: string;
  /** Human-readable line — usually "last linked 3 days ago" or null. */
  detail?: string | null;
}

/**
 * Shared "Disconnected" surface used by the four connection pages.
 * Defensive: requireOnboardingComplete should have redirected before
 * we render — this only shows when something raced (disconnect just
 * happened, page still loading). Single visual treatment keeps the
 * connection pages feeling like one product surface.
 */
export function DisconnectedNotice({ reconnectHref, detail }: Props) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
        <div className="flex items-start gap-3">
          <div className="bg-bg-active flex h-9 w-9 shrink-0 items-center justify-center rounded text-[color:var(--destructive-color)]">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div>
            <p className="text-fg font-medium">Disconnected</p>
            {detail && <p className="text-fg-muted text-xs">{detail}</p>}
          </div>
        </div>
        <Button asChild size="sm">
          <Link href={reconnectHref}>Reconnect</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
