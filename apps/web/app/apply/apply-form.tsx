'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { applyAction } from './actions';

const SPEND_RANGES = [
  '',
  '< $5k / month',
  '$5k–$25k / month',
  '$25k–$100k / month',
  '$100k–$500k / month',
  '$500k+ / month',
] as const;

const VERTICAL_OPTIONS = [
  'MMO',
  'Biz-opp',
  'Finance',
  'Crypto',
  'Sweeps',
  'Ecom',
  'Lead-gen',
  'Other',
] as const;

const HEARD_FROM = ['', 'Twitter', 'YouTube', 'Referral', 'Search', 'Other'] as const;

export function ApplyForm() {
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [agencyName, setAgencyName] = React.useState('');
  const [spend, setSpend] = React.useState<(typeof SPEND_RANGES)[number]>('');
  const [verticals, setVerticals] = React.useState<string[]>([]);
  const [whyApply, setWhyApply] = React.useState('');
  const [heardFrom, setHeardFrom] = React.useState<(typeof HEARD_FROM)[number]>('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);

  function toggleVertical(v: string) {
    setVerticals((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await applyAction({
      email,
      name,
      agencyName: agencyName || undefined,
      monthlyAdSpendUsd: spend || undefined,
      verticals,
      whyApply: whyApply || undefined,
      heardFrom: heardFrom || undefined,
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
      <div className="space-y-3 text-sm">
        <p className="text-foreground font-medium">Application received. ✓</p>
        <p className="text-muted-foreground">
          We review every application personally. You&apos;ll hear from us within 48 hours at{' '}
          <code className="font-mono">{email}</code>.
        </p>
        <p className="text-muted-foreground text-xs">
          Already have an invite code?{' '}
          <Link href="/signup" className="text-primary underline underline-offset-4">
            Sign up →
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="email">Email *</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Your name *</Label>
          <Input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="agency">
          Agency / company <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="agency"
          type="text"
          value={agencyName}
          onChange={(e) => setAgencyName(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="spend">
          Monthly ad spend <span className="text-muted-foreground">(optional)</span>
        </Label>
        <select
          id="spend"
          value={spend}
          onChange={(e) => setSpend(e.target.value as (typeof SPEND_RANGES)[number])}
          className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
        >
          {SPEND_RANGES.map((s) => (
            <option key={s} value={s}>
              {s || '— select —'}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>
          Verticals <span className="text-muted-foreground">(select all that apply)</span>
        </Label>
        <div className="flex flex-wrap gap-2">
          {VERTICAL_OPTIONS.map((v) => {
            const on = verticals.includes(v);
            return (
              <button
                type="button"
                key={v}
                onClick={() => toggleVertical(v)}
                className={
                  'rounded-full border px-3 py-1 text-xs transition-colors ' +
                  (on
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-card hover:bg-accent/30')
                }
              >
                {v}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="why">
          Why are you applying? <span className="text-muted-foreground">(optional)</span>
        </Label>
        <textarea
          id="why"
          value={whyApply}
          onChange={(e) => setWhyApply(e.target.value)}
          rows={4}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          maxLength={1000}
          placeholder="What's your bottleneck right now? Anything you want us to know about your stack."
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="heard">
          How did you hear about us? <span className="text-muted-foreground">(optional)</span>
        </Label>
        <select
          id="heard"
          value={heardFrom}
          onChange={(e) => setHeardFrom(e.target.value as (typeof HEARD_FROM)[number])}
          className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
        >
          {HEARD_FROM.map((h) => (
            <option key={h} value={h}>
              {h || '— select —'}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit application'}
      </Button>
      <p className="text-muted-foreground text-center text-xs">
        Already have an invite code?{' '}
        <Link href="/signup" className="text-primary underline underline-offset-4">
          Sign up →
        </Link>
      </p>
    </form>
  );
}
