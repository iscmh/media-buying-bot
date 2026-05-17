import { AppShell } from '@/components/shell/app-shell';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ConceptDetailLoading() {
  return (
    <AppShell
      crumbs={[{ label: 'Concepts', href: '/concepts' }, { label: '…' }]}
      contentClass="max-w-3xl"
    >
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96" />
      </div>

      <Skeleton className="mb-6 aspect-video w-full rounded-md" />

      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-96" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    </AppShell>
  );
}
