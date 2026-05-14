import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Phase 7: minimal Badge primitive. shadcn ships one of these but it
 * wasn't imported into this project; this is the same API.
 */
export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'gold';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClass: Record<BadgeVariant, string> = {
  default: 'bg-primary text-primary-foreground border-transparent',
  secondary: 'bg-secondary text-secondary-foreground border-transparent',
  outline: 'text-foreground border-border',
  destructive: 'bg-destructive text-destructive-foreground border-transparent',
  // Phase 7 founding-member accent. Tailwind's amber-500 reads gold-ish
  // in both light + dark themes without dragging in a new palette.
  gold: 'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300',
};

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-none',
        variantClass[variant],
        className,
      )}
      {...props}
    />
  );
}
