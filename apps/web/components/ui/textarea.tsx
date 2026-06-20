import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * Polish-17 Phase 2: textarea primitive.
 *
 * Mirrors the Input component (squarer corners, recessed bg, tighter
 * focus). Defaults to min-h-20 (~80px) which is roughly 3 lines of
 * content — most form-level long-form fields land in that range.
 * Consumers override className for taller targets.
 *
 * Like Input, supports a `mono` prop for fields holding technical
 * content (script bodies, prompt text, JSON, etc.). For narrative
 * fields (descriptions, notes, dialogue) leave mono off — the
 * default sans body face reads as natural-language.
 */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Polish-17: render with mono font for prompt bodies / JSON / scripts. */
  mono?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, mono, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'border-input bg-bg-inset placeholder:text-fg-subtle focus-visible:border-border-strong flex min-h-20 w-full rounded-sm border px-3 py-2 text-sm leading-relaxed focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          mono && 'font-mono',
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
