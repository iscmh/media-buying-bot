import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApplyForm } from './apply-form';

export const metadata = { title: 'Apply — Media Buying Bot' };

export default function ApplyPage() {
  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>Apply for access</CardTitle>
          <CardDescription>
            Access is by application. We review every submission personally — usually within 48
            hours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApplyForm />
        </CardContent>
      </Card>
    </main>
  );
}
