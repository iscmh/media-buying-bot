import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PublicShell } from '@/components/shell/public-shell';
import { SignupForm } from './signup-form';

export const metadata = { title: 'Sign up' };

export default function SignupPage() {
  return (
    <PublicShell>
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">Create your account</CardTitle>
            <CardDescription>
              By signing up you agree to the{' '}
              <Link href="/legal/tos" className="hover:text-fg underline transition-colors">
                Terms of Service
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SignupForm />
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
