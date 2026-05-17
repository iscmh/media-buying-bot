import { AppShell } from '@/components/shell/app-shell';
import { Skeleton } from '@/components/ui/skeleton';

export default function LaunchedLoading() {
  return (
    <AppShell crumbs={[{ label: 'Launched ads' }]}>
      <div className="mb-6 space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="overflow-hidden rounded-md border">
        <Skeleton className="bg-bg-elevated h-10 w-full" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="border-border h-16 w-full border-t" />
        ))}
      </div>
    </AppShell>
  );
}
