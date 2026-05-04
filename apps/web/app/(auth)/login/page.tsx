import Link from 'next/link';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from './login-form';

export const metadata = { title: 'Log in — Media Buying Bot' };

export default function LoginPage() {
  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>
            New here?{' '}
            <Link href="/signup" className="underline">
              Create an account
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* useSearchParams() in LoginForm requires a Suspense boundary
              for static generation. Without it, Next bails out to client-only. */}
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
