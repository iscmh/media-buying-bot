import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PublicShell } from '@/components/shell/public-shell';
import { ApplyForm } from './apply-form';

export const metadata = { title: 'Apply' };

export default function ApplyPage() {
  return (
    <PublicShell>
      <div className="flex flex-1 items-start justify-center px-6 py-12">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle className="text-xl">Apply for access</CardTitle>
            <CardDescription>
              Access is by application. We review every submission personally — usually within 48
              hours.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ApplyForm />
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
