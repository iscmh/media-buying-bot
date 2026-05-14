import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WaitlistForm } from './waitlist-form';

export const metadata = { title: 'Waitlist — Media Buying Bot' };

export default function WaitlistPage() {
  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Join the waitlist</CardTitle>
          <CardDescription>
            We&apos;re onboarding operators slowly. Drop your email and we&apos;ll send an invite
            when a spot opens.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WaitlistForm />
        </CardContent>
      </Card>
    </main>
  );
}
