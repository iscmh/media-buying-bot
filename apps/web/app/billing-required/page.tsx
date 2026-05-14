import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkActiveSubscription } from '@mbb/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Subscription required — Media Buying Bot' };
export const dynamic = 'force-dynamic';

type Reason = 'no_subscription' | 'past_due' | 'canceled' | 'expired';

interface Props {
  searchParams: Promise<{ reason?: string }>;
}

export default async function BillingRequiredPage({ searchParams }: Props) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // If we somehow land here with access (race vs webhook), bounce to
  // dashboard — better UX than showing "you don't have access" to a
  // user who actually does.
  const sub = await checkActiveSubscription(user.id);
  if (sub.hasAccess) redirect('/dashboard');

  const { reason: reasonParam } = await searchParams;
  const reason = normalizeReason(reasonParam, sub.reason as Reason);
  const copy = REASON_COPY[reason];

  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sub.currentPeriodEnd && (
            <p className="text-muted-foreground text-sm">
              Last period ended {sub.currentPeriodEnd.toISOString().slice(0, 10)}.
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {reason === 'no_subscription' ? (
              <Button asChild>
                <Link href="/apply">Apply for access</Link>
              </Button>
            ) : (
              <Button asChild>
                <a href="https://whop.com/orders" target="_blank" rel="noopener noreferrer">
                  Manage billing on Whop ↗
                </a>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href="/apply">Re-apply</Link>
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Trouble accessing your account? Reply to your invite email and we&apos;ll sort it.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

function normalizeReason(param: string | undefined, fallback: Reason): Reason {
  if (
    param === 'no_subscription' ||
    param === 'past_due' ||
    param === 'canceled' ||
    param === 'expired'
  ) {
    return param;
  }
  return fallback;
}

const REASON_COPY: Record<Reason, { title: string; description: string }> = {
  no_subscription: {
    title: 'Subscription required',
    description:
      'Access to Media Buying Bot is by application. Apply below and we review every submission personally — usually within 48 hours.',
  },
  past_due: {
    title: 'Payment failed',
    description:
      "Your latest Whop renewal didn't go through. Update your payment method on Whop to get back in.",
  },
  canceled: {
    title: 'Subscription canceled',
    description:
      'Your access has been canceled. You can re-subscribe via Whop, or re-apply for a fresh tier.',
  },
  expired: {
    title: 'Subscription expired',
    description: 'Your access period ended. Renew on Whop to continue, or re-apply.',
  },
};
