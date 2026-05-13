'use client';

import * as React from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

const RANGES = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
] as const;

export function TimeRangePicker({ current }: { current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function pick(next: string) {
    const sp = new URLSearchParams(params.toString());
    sp.set('range', next);
    React.startTransition(() => {
      router.replace(`${pathname}?${sp.toString()}`);
    });
  }

  return (
    <div className="bg-card inline-flex gap-1 rounded-lg border p-1 text-sm">
      {RANGES.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => pick(r.value)}
          className={
            'rounded-md px-3 py-1 transition-colors ' +
            (current === r.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent/30')
          }
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
