import { cn } from '@/lib/utils';

/** Placeholder block while content is loading. Pulses subtly. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('bg-bg-active animate-pulse rounded-md', className)} {...props} />;
}
