import { formatDateTime } from '@/lib/format/date';
import { AlertCircle } from 'lucide-react';
import { UnpauseButton } from './unpause-button';

interface Props {
  reason: string;
  pausedAt: Date;
  pausedBy: 'user' | 'admin' | 'auto';
  openPauseCount: number;
  /**
   * Polish-25.7 Commit 43: full list of open pause reasons (not just the
   * latest). Threaded into UnpauseButton so it can warn on
   * meta_disconnected + metaStillDisconnected.
   */
  openReasons: string[];
  metaStillDisconnected: boolean;
}

const REASON_LABELS: Record<string, string> = {
  meta_disconnected: 'You disconnected Meta. Reconnect from Connections → Meta to resume.',
  telegram_disconnected:
    "Telegram integration is offline. Approve kill/scale recommendations on the /launched page instead — Ads Bot doesn't auto-pause for this reason anymore.",
  ai_provider_disconnected:
    'You disconnected your AI UGC provider. Reconnect from Connections → AI provider to resume.',
};

/**
 * Red strip rendered at the top of the dashboard whenever users.is_paused.
 * Static parts are server-rendered; the Unpause button is a small client
 * component (UnpauseButton) that owns the confirm dialog + action call.
 */
export function PauseBanner({
  reason,
  pausedAt,
  pausedBy,
  openPauseCount,
  openReasons,
  metaStillDisconnected,
}: Props) {
  const message = REASON_LABELS[reason] ?? `Bot is paused: ${reason}.`;

  return (
    <div className="border-destructive/40 bg-destructive/5 mb-8 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start">
      <AlertCircle className="text-destructive mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        <p className="font-semibold">Bot is paused</p>
        <p className="text-muted-foreground mt-1 text-sm">{message}</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Paused {formatDateTime(pausedAt)} by {pausedBy === 'auto' ? 'the platform' : pausedBy}.
        </p>
      </div>
      <UnpauseButton
        openPauseCount={openPauseCount}
        openReasons={openReasons}
        metaStillDisconnected={metaStillDisconnected}
      />
    </div>
  );
}
