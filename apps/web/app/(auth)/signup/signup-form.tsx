'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { validateInviteCodeAction } from './actions';

export function SignupForm() {
  const router = useRouter();
  const [inviteCode, setInviteCode] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    // Phase 7: validate the invite code BEFORE creating the auth user.
    // The trigger re-validates atomically with FOR UPDATE; this is the
    // UX nicety that turns "signup failed" into "your code expired".
    const codeResult = await validateInviteCodeAction(inviteCode);
    if (!codeResult.ok || !codeResult.inviteCodeId) {
      setSubmitting(false);
      setError(codeResult.errorMessage ?? 'Invalid invite code.');
      return;
    }

    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/api/auth/callback`,
        // The auth.users INSERT trigger reads invite_code_id off
        // raw_user_meta_data and redeems atomically with row creation.
        data: { invite_code_id: codeResult.inviteCodeId },
      },
    });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push('/dashboard');
  }

  async function onGoogle() {
    setError(null);
    // OAuth path: validate the code + drop a server-side cookie so
    // /api/auth/callback can redeem post-creation via service-role.
    // Atomicity is best-effort here (the trigger can't see metadata
    // we'd attach client-side to an OAuth flow) — email signup remains
    // the strict gate; OAuth is a convenience.
    const codeResult = await validateInviteCodeAction(inviteCode);
    if (!codeResult.ok) {
      setError(codeResult.errorMessage ?? 'Invalid invite code.');
      return;
    }
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/api/auth/callback` },
    });
  }

  const codeLooksValid = inviteCode.trim().length > 0;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="invite-code">Invite code</Label>
        <Input
          id="invite-code"
          type="text"
          required
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
          placeholder="ABC12345"
          autoComplete="off"
          spellCheck={false}
          mono
          className="uppercase tracking-wider"
        />
        <p className="text-fg-muted text-xs">
          No code?{' '}
          <Link href="/waitlist" className="text-fg underline-offset-4 hover:underline">
            Join the waitlist
          </Link>
        </p>
      </div>
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
      <Button
        type="submit"
        variant="primary"
        className="w-full"
        disabled={submitting || !codeLooksValid}
      >
        {submitting ? 'Creating…' : 'Create account'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={onGoogle}
        disabled={!codeLooksValid}
      >
        Continue with Google
      </Button>
    </form>
  );
}
