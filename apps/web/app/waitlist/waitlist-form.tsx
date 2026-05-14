'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { joinWaitlistAction } from './actions';

const SOURCE_OPTIONS = ['', 'twitter', 'referral', 'direct', 'youtube', 'other'] as const;

export function WaitlistForm() {
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [source, setSource] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await joinWaitlistAction({
      email,
      name: name || undefined,
      source: source || undefined,
      message: message || undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Something went wrong.');
      return;
    }
    setSuccess(true);
  }

  if (success) {
    return (
      <div className="space-y-4 text-sm">
        <p className="text-foreground font-medium">You&apos;re on the list. ✓</p>
        <p className="text-muted-foreground">
          We&apos;ll email <code className="font-mono">{email}</code> when a spot opens. In the
          meantime, ping{' '}
          <Link href="https://twitter.com/" className="text-primary underline underline-offset-4">
            our Twitter
          </Link>{' '}
          for updates.
        </p>
        <p className="text-muted-foreground text-xs">
          Already have a code?{' '}
          <Link href="/signup" className="text-primary underline underline-offset-4">
            Sign up →
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">
          Name <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="source">
          How did you hear about us? <span className="text-muted-foreground">(optional)</span>
        </Label>
        <select
          id="source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
        >
          {SOURCE_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt || '— select —'}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="message">
          Anything we should know? <span className="text-muted-foreground">(optional)</span>
        </Label>
        <textarea
          id="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          maxLength={500}
        />
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Saving…' : 'Join waitlist'}
      </Button>
      <p className="text-muted-foreground text-center text-xs">
        Already have a code?{' '}
        <Link href="/signup" className="text-primary underline underline-offset-4">
          Sign up →
        </Link>
      </p>
    </form>
  );
}
