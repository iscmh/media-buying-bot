import Link from 'next/link';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PublicShell } from '@/components/shell/public-shell';
import { LoginForm } from './login-form';

export const metadata = { title: 'Log in' };

export default function LoginPage() {
  return (
    <PublicShell>
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Log in</CardTitle>
            <CardDescription>
              New here?{' '}
              <Link href="/apply" className="hover:text-fg underline-offset-4 hover:underline">
                Apply for access
              </Link>
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
      </div>
    </PublicShell>
  );
}
