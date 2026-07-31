'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  ArrowRight,
  FileVideo,
  LayoutDashboard,
  ListTodo,
  Plug,
  Rocket,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Polish-25.5 Commit 27: global command palette (Cmd+K / Ctrl+K).
 *
 * Bloomberg mnemonic navigation, TradingView Ctrl+K symbol search,
 * VS Code / Linear command palette. Type to jump anywhere. Every
 * pro tool in the reference set has one; the current app has none.
 *
 * Functional at ship (operator requirement 2):
 *   - Static navigation targets — every primary route with an
 *     assigned mnemonic (Dashboard=d, Concepts=c, Runs=r,
 *     Launched=l, Pending=p, Presets=e, Rules=u, Settings=s,
 *     Connections=n).
 *   - Recent items — the shell passes in the last 30 concepts,
 *     30 generation jobs, and 30 launched ads. All filterable
 *     client-side, no round-trip.
 *   - Fuzzy substring match on label + subtitle.
 *   - ↑ / ↓ to move, Enter to open, Esc to close.
 *   - Two-letter chord: press `g` then a route letter (`gd`, `gc`,
 *     `gr`, `gl`, `gp`, `gs`, `gn`) anywhere in the app to jump
 *     without opening the palette.
 *
 * Keyboard shortcuts help: `?` opens a small legend panel below
 * the input.
 */

export type PaletteItem =
  | {
      kind: 'route';
      id: string;
      label: string;
      subtitle?: string;
      icon: React.ComponentType<{ className?: string }>;
      href: string;
      mnemonic?: string;
    }
  | { kind: 'concept'; id: string; label: string; subtitle?: string; href: string }
  | { kind: 'run'; id: string; label: string; subtitle?: string; href: string }
  | { kind: 'launched'; id: string; label: string; subtitle?: string; href: string };

const ROUTE_ITEMS: PaletteItem[] = [
  {
    kind: 'route',
    id: 'route-dashboard',
    label: 'Dashboard',
    subtitle: 'KPI overview + per-ad performance',
    icon: LayoutDashboard,
    href: '/dashboard',
    mnemonic: 'd',
  },
  {
    kind: 'route',
    id: 'route-concepts',
    label: 'Concepts',
    subtitle: 'Upload a new source ad or open an existing one',
    icon: FileVideo,
    href: '/concepts',
    mnemonic: 'c',
  },
  {
    kind: 'route',
    id: 'route-runs',
    label: 'Runs',
    subtitle: 'Generation jobs (in-flight + completed)',
    icon: Workflow,
    href: '/runs',
    mnemonic: 'r',
  },
  {
    kind: 'route',
    id: 'route-launched',
    label: 'Launched ads',
    subtitle: 'Every ad live on Meta',
    icon: Rocket,
    href: '/launched',
    mnemonic: 'l',
  },
  {
    kind: 'route',
    id: 'route-pending',
    label: 'Pending approval',
    subtitle: 'Variants waiting to launch across every run',
    icon: ListTodo,
    href: '/pending',
    mnemonic: 'p',
  },
  {
    kind: 'route',
    id: 'route-presets',
    label: 'Launch presets',
    subtitle: 'Named parameter bundles for one-click launches',
    icon: Sparkles,
    href: '/settings/presets',
    mnemonic: 'e',
  },
  {
    kind: 'route',
    id: 'route-rules',
    label: 'Automation rules',
    subtitle: 'Kill / pause / scale thresholds',
    icon: SlidersHorizontal,
    href: '/settings/rules',
    mnemonic: 'u',
  },
  {
    kind: 'route',
    id: 'route-settings',
    label: 'Settings',
    subtitle: 'Kill rules, scale tiers, caps, defaults',
    icon: Settings,
    href: '/settings',
    mnemonic: 's',
  },
  {
    kind: 'route',
    id: 'route-connections',
    label: 'Connections',
    subtitle: 'Providers, Meta, Telegram',
    icon: Plug,
    href: '/settings/connections',
    mnemonic: 'n',
  },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Recent concepts fetched server-side. */
  recentConcepts?: Array<{ id: string; name: string | null; createdAt: Date | string }>;
  /** Recent generation jobs. */
  recentJobs?: Array<{ id: string; status: string; createdAt: Date | string }>;
  /** Recent launched ads. */
  recentLaunched?: Array<{
    id: string;
    headline: string | null;
    status: string;
    launchedAt: Date | string | null;
    generationJobId?: string | null;
  }>;
}

function fuzzyMatch(needle: string, hay: string): boolean {
  if (!needle) return true;
  return hay.toLowerCase().includes(needle.toLowerCase());
}

export function CommandPalette({
  open,
  onOpenChange,
  recentConcepts = [],
  recentJobs = [],
  recentLaunched = [],
}: Props) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const [showHelp, setShowHelp] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);

  const items: PaletteItem[] = React.useMemo(() => {
    const concepts: PaletteItem[] = recentConcepts.map((c) => ({
      kind: 'concept' as const,
      id: `concept-${c.id}`,
      label: c.name ?? '(untitled concept)',
      subtitle: `concept · ${c.id.slice(0, 8)}`,
      href: `/concepts/${c.id}`,
    }));
    const runs: PaletteItem[] = recentJobs.map((j) => ({
      kind: 'run' as const,
      id: `run-${j.id}`,
      label: `Run ${j.id.slice(0, 8)}`,
      subtitle: `${j.status}`,
      href: `/runs/${j.id}`,
    }));
    const launched: PaletteItem[] = recentLaunched.map((l) => ({
      kind: 'launched' as const,
      id: `launched-${l.id}`,
      label: l.headline ?? '(no headline)',
      subtitle: `${l.status} · ad ${l.id.slice(0, 8)}`,
      href: l.generationJobId ? `/runs/${l.generationJobId}` : '/launched',
    }));
    return [...ROUTE_ITEMS, ...concepts, ...runs, ...launched];
  }, [recentConcepts, recentJobs, recentLaunched]);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return items;
    const q = query.trim();
    return items.filter(
      (it) => fuzzyMatch(q, it.label) || (it.subtitle && fuzzyMatch(q, it.subtitle)),
    );
  }, [items, query]);

  React.useEffect(() => {
    setCursor(0);
  }, [query, open]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setShowHelp(false);
    }
  }, [open]);

  function handleSelect(item: PaletteItem) {
    onOpenChange(false);
    router.push(item.href);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[cursor];
      if (item) handleSelect(item);
    } else if (e.key === '?' && query === '') {
      e.preventDefault();
      setShowHelp((v) => !v);
    }
  }

  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-cursor="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/60',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-[15%] z-50 -translate-x-1/2',
            'bg-bg-surface w-[92vw] max-w-lg overflow-hidden rounded-sm border shadow-2xl',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
          onKeyDown={handleKeyDown}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="text-fg-subtle h-4 w-4" aria-hidden />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to search: routes, concepts, runs, ads…"
              className="text-fg placeholder:text-fg-subtle flex-1 bg-transparent text-sm outline-none"
            />
            <button
              type="button"
              onClick={() => setShowHelp((v) => !v)}
              className="text-fg-subtle hover:text-fg font-mono text-[10px] uppercase tracking-wider"
              aria-label="Toggle keyboard shortcut help"
            >
              ?
            </button>
            <DialogPrimitive.Close className="text-fg-subtle hover:text-fg" aria-label="Close">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          {showHelp && (
            <div className="border-b px-3 py-2 text-xs">
              <p className="text-fg-subtle mb-1.5 text-[10px] uppercase tracking-wider">
                Keyboard shortcuts
              </p>
              <div className="text-fg-muted grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono">
                <div>⌘K / Ctrl+K</div>
                <div>Open palette</div>
                <div>↑ / ↓</div>
                <div>Move selection</div>
                <div>Enter</div>
                <div>Open</div>
                <div>Esc</div>
                <div>Close</div>
                <div>gd</div>
                <div>Go to Dashboard</div>
                <div>gc</div>
                <div>Go to Concepts</div>
                <div>gr</div>
                <div>Go to Runs</div>
                <div>gl</div>
                <div>Go to Launched</div>
                <div>gp</div>
                <div>Go to Pending</div>
                <div>gs</div>
                <div>Go to Settings</div>
                <div>gn</div>
                <div>Go to Connections</div>
              </div>
            </div>
          )}

          <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="text-fg-muted px-4 py-6 text-center text-xs">
                Nothing matches &ldquo;{query}&rdquo;.
              </div>
            )}
            {filtered.map((item, i) => (
              <PaletteRow
                key={item.id}
                item={item}
                active={i === cursor}
                cursorIndex={i}
                onSelect={() => handleSelect(item)}
                onHover={() => setCursor(i)}
              />
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PaletteRow({
  item,
  active,
  cursorIndex,
  onSelect,
  onHover,
}: {
  item: PaletteItem;
  active: boolean;
  cursorIndex: number;
  onSelect: () => void;
  onHover: () => void;
}) {
  const kindLabel: Record<PaletteItem['kind'], string> = {
    route: 'route',
    concept: 'concept',
    run: 'run',
    launched: 'ad',
  };
  const Icon = item.kind === 'route' ? item.icon : ArrowRight;
  return (
    <button
      type="button"
      data-cursor={cursorIndex}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(
        'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
        active ? 'bg-bg-surfaceHover text-fg' : 'text-fg-muted hover:bg-bg-surfaceHover/50',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-fg' : 'text-fg-subtle')} />
      <div className="min-w-0 flex-1">
        <p className={cn('truncate', active ? 'text-fg' : 'text-fg')}>{item.label}</p>
        {item.subtitle && <p className="text-fg-subtle truncate text-xs">{item.subtitle}</p>}
      </div>
      <span className="text-fg-subtle shrink-0 font-mono text-[10px] uppercase tracking-wider">
        {kindLabel[item.kind]}
        {item.kind === 'route' && item.mnemonic ? ` · g${item.mnemonic}` : ''}
      </span>
    </button>
  );
}

/**
 * Global keyboard hook — Cmd+K / Ctrl+K opens the palette,
 * `g<x>` chord jumps directly to a route.
 */
export function useCommandPaletteKeys(setOpen: (open: boolean) => void, isOpen: boolean) {
  const router = useRouter();
  const chordRef = React.useRef<{ armed: boolean; timer?: ReturnType<typeof setTimeout> }>({
    armed: false,
  });

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!isOpen);
        return;
      }

      if (isOpen) return;
      if (inField) return;

      // Two-letter chord: press g, then a route letter.
      if (!chordRef.current.armed && e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        chordRef.current.armed = true;
        if (chordRef.current.timer) clearTimeout(chordRef.current.timer);
        chordRef.current.timer = setTimeout(() => {
          chordRef.current.armed = false;
        }, 800);
        return;
      }
      if (chordRef.current.armed) {
        const route = ROUTE_ITEMS.find((r) => r.kind === 'route' && r.mnemonic === e.key);
        chordRef.current.armed = false;
        if (chordRef.current.timer) clearTimeout(chordRef.current.timer);
        if (route) {
          e.preventDefault();
          router.push(route.href);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen, isOpen, router]);
}
