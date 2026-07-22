'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Polish-25.1 Commit 10a: invite-code gate removed. Anyone with an
 * email + password can sign up and land straight in the onboarding
 * wizard (tos → risk → keys). The `raw_user_meta_data.invite_code_id`
 * path is still honored server-side by the auth.users trigger for
 * users signing up via a legacy invite link, but the field is no
 * longer requested here.
 */
export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/api/auth/callback`,
      },
    });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push('/onboarding/tos');
  }

  async function onGoogle() {
    setError(null);
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/api/auth/callback` },
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          mono
          autoComplete="email"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          mono
          autoComplete="new-password"
        />
      </div>
      {error && <p className="text-sm text-[color:var(--accent-negative)]">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create account'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={onGoogle}
        disabled={submitting}
      >
        Continue with Google
      </Button>
    </form>
  );
}
