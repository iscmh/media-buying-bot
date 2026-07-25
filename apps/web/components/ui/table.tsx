import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * Polish-17 Phase 2: data-dense operator table.
 *   - TableHead h-12 → h-9 (tighter).
 *   - Header text: text-muted-foreground (kept) + uppercase + text-xs
 *     + tracking-wider — terminal/Vercel header treatment.
 *   - Cell padding p-4 → px-3 py-2.
 *   - Row separators use border-border-subtle (#181818) instead of
 *     the default --border (#1f1f1f) for a softer divider between
 *     data rows.
 *   - Add tabularNums prop on TableCell so numeric columns line up.
 *
 * No structural API changes — existing consumers keep working.
 * Numeric columns should pass `tabularNums right` className.
 */
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    // Polish-25.4 Commit 25: Trader Terminal row hover treatment.
    // Was a subtle bg-lighten; now a 2px amber left-border that
    // appears on hover. Matches Bloomberg/TradingView row-highlight
    // pattern where the accent color marks the active/hovered row
    // instead of a background wash. The transparent placeholder
    // border on rest keeps row heights stable (no layout shift
    // when the border pops in on hover).
    <tr
      ref={ref}
      className={cn(
        'border-border-subtle border-b transition-colors',
        'border-l-2 border-l-transparent hover:border-l-[color:var(--accent-amber)]',
        'hover:bg-bg-surfaceHover/30',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'text-fg-muted h-9 px-3 text-left align-middle text-xs font-medium uppercase tracking-wider',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-3 py-2 align-middle', className)} {...props} />
));
TableCell.displayName = 'TableCell';

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
