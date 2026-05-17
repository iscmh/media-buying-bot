import { AppShell } from '@/components/shell/app-shell';
import { Skeleton } from '@/components/ui/skeleton';

export default function SettingsLoading() {
  return (
    <AppShell crumbs={[{ label: 'Settings' }]} contentClass="max-w-4xl">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* Tab strip skeleton. */}
      <div className="bg-bg-elevated mb-6 flex flex-wrap gap-1 rounded-md p-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-sm" />
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-72" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </AppShell>
  );
}
