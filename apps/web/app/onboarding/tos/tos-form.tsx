'use client';

import { useFormStatus } from 'react-dom';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { acceptTosAction } from './actions';

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending} size="lg">
      {pending ? 'Saving…' : 'Accept and continue'}
    </Button>
  );
}

export function TosAcceptForm() {
  const [agreed, setAgreed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(formData: FormData) {
    setError(null);
    const result = await acceptTosAction(formData);
    // server action returns void on success (it redirects); only here on error.
    if (result?.error) setError(result.error);
  }

  return (
    <form action={handleSubmit} className="bg-background mt-6 space-y-4 rounded-lg border p-6">
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="agreed"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="border-input mt-1 h-4 w-4 rounded"
        />
        <span>
          I have read and agree to these terms, including the indemnification, the limitation of
          liability, and the acknowledgment that Meta enforcement risk is mine.
        </span>
      </label>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <SubmitButton disabled={!agreed} />
    </form>
  );
}
