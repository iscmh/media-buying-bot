import { AppShell } from '@/components/shell/app-shell';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Dashboard loading skeleton. Mirrors the eventual layout: header +
 * 6 metric cards in a 3-col grid + chart area + table. Pulses are
 * subtle so the in-flight state still reads as "your data is on the
 * way" rather than "something's broken".
 */
export default function DashboardLoading() {
  return (
    <AppShell crumbs={[{ label: 'Dashboard' }]}>
      <div className="mb-6 space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-60" />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="space-y-3 p-4">
            <div className="flex items-start justify-between">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-4 rounded" />
            </div>
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-40" />
          </Card>
        ))}
      </div>

      <Skeleton className="mb-6 h-48 w-full rounded-md" />

      <Skeleton className="mb-3 h-4 w-32" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-md" />
        ))}
      </div>
    </AppShell>
  );
}
