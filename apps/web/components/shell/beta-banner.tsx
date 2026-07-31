import { ExternalLink, FlaskConical } from 'lucide-react';

/**
 * Polish-25.7 Commit 44: persistent "Meta launch flow is in BETA"
 * strip rendered on every Meta-launch surface (/launched, the launch
 * dialog inside runs/[id], and the Meta tab of /settings/connections).
 *
 * Amber tone reuses the existing Trader Terminal `--accent-amber`
 * token so it stacks cleanly under the destructive-red PauseBanner
 * without competing for attention. The bug-report link opens the
 * operator's Telegram group in a new tab.
 *
 * The URL is a hardcoded literal so beta testers can click through
 * without any additional env plumbing on their end. If the group
 * link ever rotates, bump the constant in one place and every
 * banner surface follows.
 */
const BUG_REPORT_URL = 'https://t.me/+m6UFJM5fnbg5M2Jh';

interface Props {
  /** Extra bottom margin, matched to the surface's own spacing. */
  className?: string;
}

export function BetaBanner({ className }: Props) {
  return (
    <div
      role="status"
      className={
        'border-[color:var(--accent-amber)]/40 bg-[color:var(--accent-amber)]/5 flex items-start gap-2 rounded-md border p-3 text-xs leading-snug ' +
        (className ?? 'mb-4')
      }
    >
      <FlaskConical
        className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--accent-amber)]"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-fg font-medium">Meta launch flow is in BETA.</p>
        <p className="text-fg-muted mt-0.5">
          Test with small budgets ($5-20/day) while we harden the flow. Hit a bug? Drop it in the
          beta feedback channel so we can chase it fast.
        </p>
        <a
          href={BUG_REPORT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg mt-1.5 inline-flex items-center gap-1 underline-offset-4 hover:text-[color:var(--accent-amber)] hover:underline"
        >
          Report a bug
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}
