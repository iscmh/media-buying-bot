import Link from 'next/link';
import { Coins } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Polish-29.0.3 Commit 113: always-visible balance pill in the top
 * toolbar. Renders {balance.toLocaleString()} credits with a coin
 * glyph and links to /settings/credits.
 *
 * Server component — the parent (AppShell) fetches the balance in the
 * same round-trip as everything else and passes it in, so no extra
 * DB hop per page render.
 *
 * When balance <= LOW_BALANCE_THRESHOLD the pill switches to a warm
 * amber tone. Below 20 credits (roughly one Seedance clip) it goes
 * red — a very-visible push toward top-up before the user hits
 * InsufficientCreditsError on submit.
 */

const LOW_BALANCE_THRESHOLD = 200; // ~5 Seedance clips
const CRITICAL_BALANCE_THRESHOLD = 20;

export interface BalancePillProps {
  balance: number;
  className?: string;
}

export function BalancePill({ balance, className }: BalancePillProps) {
  const tone = pillTone(balance);
  return (
    <Link
      href="/settings/credits"
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
        tone,
        className,
      )}
      aria-label={`Credit balance: ${balance} credits — click to view details or top up`}
    >
      <Coins className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="tabular-nums">{balance.toLocaleString()}</span>
      <span className="hidden text-[10px] font-normal opacity-70 sm:inline">credits</span>
    </Link>
  );
}

function pillTone(balance: number): string {
  if (balance <= CRITICAL_BALANCE_THRESHOLD) {
    return 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300';
  }
  if (balance <= LOW_BALANCE_THRESHOLD) {
    return 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300';
  }
  return 'border-border bg-bg-surface text-fg-muted hover:bg-bg-surfaceHover hover:text-fg';
}

export function isLowBalance(balance: number): boolean {
  return balance <= LOW_BALANCE_THRESHOLD;
}

export function isCriticalBalance(balance: number): boolean {
  return balance <= CRITICAL_BALANCE_THRESHOLD;
}

export { LOW_BALANCE_THRESHOLD, CRITICAL_BALANCE_THRESHOLD };
