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
 *   1. Keys connected (Claude + Gemini + MakeUGC)
 *   2. First concept uploaded
 *   3. First ad generated (any completed generation job)
 *
 * Each row shows a green check when done, a hollow circle + CTA
 * link when not. Once all 3 are done, the checklist gives way to
 * the "Launch your first ad on Meta" nudge — the last step before
 * live-spend metrics start populating.
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
  const items: Item[] = [
    {
      done: state.keysConnected,
      title: 'Connect your API keys',
      description: 'Claude + Gemini + MakeUGC. Bring-your-own-key — pay providers directly.',
      cta: { href: '/settings/connections', label: 'Connect keys' },
    },
    {
      done: state.hasConcept,
      title: 'Upload a winning ad',
      description:
        'Point the bot at a proven UGC video or static image. Gemini will analyze the persona + hook.',
      cta: { href: '/concepts', label: 'Upload a concept' },
    },
    {
      done: state.hasGeneratedAd,
      title: 'Generate your first variant',
      description: 'One click to run the Polish-25 MakeUGC pipeline. ~$0.07 per 60-second variant.',
      cta: { href: '/concepts', label: 'Open Concepts' },
    },
    {
      done: state.hasLaunchedAd,
      title: 'Launch on Meta',
      description:
        'Connect Meta when you’re ready to push a variant live. Optional — you can generate + review videos first.',
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
