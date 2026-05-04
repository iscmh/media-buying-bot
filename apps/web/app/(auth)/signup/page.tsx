import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignupForm } from './signup-form';

export const metadata = { title: 'Sign up — Media Buying Bot' };

export default function SignupPage() {
  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            Free during MVP. By signing up you agree to the{' '}
            <Link href="/legal/tos" className="underline">
              Terms of Service
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignupForm />
        </CardContent>
      </Card>
    </main>
  );
}
