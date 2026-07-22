import Link from 'next/link';
import { ArrowRight, Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Polish-25.1 Commit 10b: dashboard empty-state.
 *
 * When a user has spent $0 (no launched ad has produced spend), the
 * default metrics grid reads as 6 empty $0 cards with no next-step
 * signal. This checklist replaces it with a task list that mirrors
 * the real journey to first ad:
 *
 *   1. Keys connected (Claude + Gemini — the two remaining BYOK
 *      keys after Polish-25.2 Commit 11 moved MakeUGC to platform-
 *      managed Instant UGC)
 *   2. First concept uploaded
 *   3. First variant generated
 *   4. First ad launched on Meta
 *
 * Each row shows a green check when done, a hollow circle + CTA
 * link when not. As soon as launched-ad spend lands, the dashboard
 * flips back to the full metrics layout.
 */
export interface ChecklistState {
  keysConnected: boolean;
  hasConcept: boolean;
  hasGeneratedAd: boolean;
  hasLaunchedAd: boolean;
}

interface Props {
  state: ChecklistState;
}

interface Item {
  done: boolean;
  title: string;
  description: string;
  cta: { href: string; label: string };
}

export function GettingStartedChecklist({ state }: Props) {
  // Polish-25.2 Commit 12: consolidated steps 2 + 3 (they both
  // pointed at /concepts, felt like the same step). Now:
  //   1. Connect keys → /settings/connections
  //   2. Upload a winning ad → /concepts
  //   3. Generate a variation → /concepts (open the uploaded ad
  //      + click Generate)
  //   4. Connect Meta to launch → /settings/connections?tab=meta
  // Descriptions kept short — no more Claude / Gemini specifics
  // in the user-facing copy.
  const items: Item[] = [
    {
      done: state.keysConnected,
      title: 'Connect your API keys',
      description: 'Bring-your-own-key for Claude + Gemini. Instant UGC video is included.',
      cta: { href: '/settings/connections', label: 'Connect keys' },
    },
    {
      done: state.hasConcept,
      title: 'Upload a winning ad',
      description: 'UGC video or static image — the ad you want to iterate off of.',
      cta: { href: '/concepts', label: 'Upload' },
    },
    {
      done: state.hasGeneratedAd,
      title: 'Generate a variation',
      description: 'Open your uploaded ad, hit Generate, review the variants.',
      cta: { href: '/concepts', label: 'Open concepts' },
    },
    {
      done: state.hasLaunchedAd,
      title: 'Launch on Meta',
      description: 'Connect Meta when you’re ready to push a variant live.',
      cta: { href: '/settings/connections?tab=meta', label: 'Connect Meta' },
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const total = items.length;
  const nextItem = items.find((i) => !i.done);

  return (
    <section
      className="border-border-subtle bg-bg-surface mb-6 rounded-md border p-6"
      aria-labelledby="getting-started-heading"
    >
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h2 id="getting-started-heading" className="text-fg text-base font-semibold">
          Get to your first ad
        </h2>
        <span className="text-fg-muted font-mono text-xs">
          {doneCount} / {total}
        </span>
      </div>

      <ol className="space-y-3">
        {items.map((item, i) => (
          <li
            key={i}
            className={cn(
              'border-border-subtle flex items-start gap-3 rounded-md border px-4 py-3 text-sm transition-colors',
              item.done ? 'bg-bg-inset/40' : 'bg-bg-base',
              !item.done && item === nextItem && 'border-fg/25',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                item.done
                  ? 'bg-[color:var(--accent-positive)]/10 border-[color:var(--accent-positive)] text-[color:var(--accent-positive)]'
                  : 'border-fg-subtle text-fg-subtle',
              )}
              aria-hidden
            >
              {item.done ? <Check className="h-3 w-3" /> : <Circle className="h-2 w-2" />}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-fg font-medium',
                  item.done && 'text-fg-muted decoration-fg-subtle line-through',
                )}
              >
                {item.title}
              </p>
              <p className="text-fg-muted mt-0.5 text-xs leading-relaxed">{item.description}</p>
            </div>
            {!item.done && (
              <Link
                href={item.cta.href}
                className={cn(
                  'shrink-0 whitespace-nowrap text-xs',
                  item === nextItem
                    ? 'text-fg hover:text-fg group inline-flex items-center gap-1 font-medium'
                    : 'text-fg-muted hover:text-fg',
                )}
              >
                {item.cta.label}
                {item === nextItem && (
                  <ArrowRight
                    className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                )}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
