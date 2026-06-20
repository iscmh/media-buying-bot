import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * Polish-17 Phase 2: operator-console input.
 *   - rounded-md → rounded-sm (sharper corners).
 *   - bg-background → bg-bg-inset (recessed against bg-card/surface).
 *   - h-10 → h-9 (tighter density).
 *   - Add `mono` prop for fields that hold IDs / keys / codes
 *     (API keys, URLs, technical strings). Affiliates expect
 *     monospace for "look at this string" data.
 *   - Focus border tightens to border-border-strong instead of a
 *     wide ring — less visual noise.
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Polish-17: render with mono font for IDs / keys / URLs / codes. */
  mono?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, mono, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'border-input bg-bg-inset placeholder:text-fg-subtle focus-visible:border-border-strong flex h-9 w-full rounded-sm border px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          mono && 'font-mono',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
