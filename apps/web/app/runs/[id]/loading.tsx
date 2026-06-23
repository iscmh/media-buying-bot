import { AppShell } from '@/components/shell/app-shell';
import { Skeleton } from '@/components/ui/skeleton';

export default function JobLoading() {
  return (
    <AppShell
      crumbs={[{ label: 'Jobs', href: '/concepts' }, { label: '…' }]}
      contentClass="max-w-5xl"
    >
      <div className="mb-6 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-full" />
          ))}
        </div>
      </div>

      {/* Pipeline timeline skeleton. */}
      <div className="bg-bg-elevated mb-6 space-y-3 rounded-md border p-4">
        <Skeleton className="h-4 w-20" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="h-4 w-4 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
        ))}
      </div>

      {/* Variants grid skeleton. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square w-full rounded-md" />
        ))}
      </div>
    </AppShell>
  );
}
