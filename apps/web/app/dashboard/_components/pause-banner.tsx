import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  reason: string;
  pausedAt: Date;
  pausedBy: 'user' | 'admin' | 'auto';
}

const REASON_LABELS: Record<string, string> = {
  meta_disconnected: 'You disconnected Meta. Reconnect from Connections → Meta to resume.',
  telegram_disconnected:
    'You disconnected Telegram. Re-link from Connections → Telegram to resume.',
  ai_provider_disconnected:
    'You disconnected your AI UGC provider. Reconnect from Connections → AI provider to resume.',
};

/**
 * Red strip rendered at the top of the dashboard whenever users.is_paused.
 * Shows the most-recent pause-log reason in plain English where we have a
 * mapping; falls back to the raw reason string for unknown causes (admin
 * actions, future suspicious-activity auto-pause, etc.).
 *
 * The Unpause button is intentionally disabled in Phase 2b — the wire-up
 * (write users.is_paused=false, set unpaused_at on the active log row,
 * audit log) lands in Phase 2c. Showing the button now is operator-honest
 * about the path forward; hiding it would feel like the platform is
 * stuck.
 */
export function PauseBanner({ reason, pausedAt, pausedBy }: Props) {
  const message = REASON_LABELS[reason] ?? `Bot is paused: ${reason}.`;

  return (
    <div className="border-destructive/40 bg-destructive/5 mb-8 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start">
      <AlertCircle className="text-destructive mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        <p className="font-semibold">Bot is paused</p>
        <p className="text-muted-foreground mt-1 text-sm">{message}</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Paused {pausedAt.toLocaleString()} by {pausedBy === 'auto' ? 'the platform' : pausedBy}.
        </p>
      </div>
      <div title="Available in Phase 2c">
        <Button type="button" variant="outline" size="sm" disabled>
          Unpause
        </Button>
      </div>
    </div>
  );
}
