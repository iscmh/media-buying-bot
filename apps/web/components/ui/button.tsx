import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/*
 * Polish-17 Phase 2: operator-console button vocabulary.
 *   - Three canonical variants: primary (inverted, high contrast),
 *     secondary (surface bg + hairline), ghost (transparent).
 *   - Legacy variants preserved so existing call sites don't break;
 *     Phase 3 migrates them and we drop the legacy keys at the end.
 *   - Sizes shrunk: default h-10 → h-9; sm h-9 → h-7. Tighter density.
 *   - Radius cascaded from --radius (2px) via rounded-sm.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Polish-17 canonical variants.
        primary: 'bg-fg text-fg-inverse hover:bg-fg/90',
        secondary: 'bg-bg-surface text-fg border border-border hover:bg-bg-surfaceHover',
        ghost: 'bg-transparent text-fg-muted hover:text-fg hover:bg-bg-surface',
        // Legacy variants — preserved so existing pages don't break.
        // Repainted lightly to track the Phase 1 token shifts.
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-bg-surface text-[color:var(--accent-negative)] border border-[color:var(--accent-negative)]/40 hover:bg-bg-surfaceHover',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        // Polish-17 canonical sizes — tighter densities.
        sm: 'h-7 px-2 text-xs',
        md: 'h-9 px-3 py-1.5 text-sm',
        lg: 'h-10 px-4 py-2 text-sm',
        // Legacy aliases.
        default: 'h-9 px-3 py-1.5 text-sm',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
