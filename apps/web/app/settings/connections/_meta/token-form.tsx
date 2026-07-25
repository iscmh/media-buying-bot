'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { META_REQUIRED_SCOPES } from '@mbb/shared';
import { verifyMetaTokenAction } from './actions';

function VerifyButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="accent" disabled={pending} size="lg">
      {pending ? 'Verifying with Meta…' : 'Verify token'}
    </Button>
  );
}

export function MetaTokenPasteForm() {
  const [reveal, setReveal] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [token, setToken] = React.useState('');

  async function handleSubmit(formData: FormData) {
    setError(null);
    const result = await verifyMetaTokenAction(formData);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Verification failed.');
      return;
    }
    // Server action sets status='pending'; refresh the page to land in
    // sub-state (b) and render the BM picker.
    if (typeof window !== 'undefined') window.location.reload();
  }

  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Connect Meta</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          You provide your own Meta Developer App + long-lived access token. We verify it, encrypt
          it, and store the ciphertext. We never see your Facebook password.
        </p>
      </header>

      <section className="bg-card mb-6 space-y-4 rounded-lg border p-6 text-sm leading-relaxed">
        <h2 className="text-base font-semibold">How to generate a token (~5 minutes)</h2>
        <ol className="list-inside list-decimal space-y-2">
          <li>
            Open{' '}
            <a
              href="https://developers.facebook.com/apps/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              developers.facebook.com/apps
            </a>{' '}
            and create a new app. Type: <strong>Business</strong>. Use case: <strong>Other</strong>.
          </li>
          <li>
            In your new app, add the <strong>Marketing API</strong> product from the dashboard (left
            sidebar → Products → Add).
          </li>
          <li>
            Open the{' '}
            <a
              href="https://developers.facebook.com/tools/explorer/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Graph API Explorer
            </a>
            , pick your new app from the dropdown, and click <strong>Generate Access Token</strong>.
          </li>
          <li>
            When prompted for permissions, select all five required scopes:
            <ul className="ml-5 mt-2 list-disc space-y-1 font-mono text-xs">
              {META_REQUIRED_SCOPES.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </li>
          <li>
            Click the <em>info icon</em> next to the generated token →{' '}
            <strong>Open in Access Token Tool</strong> → <strong>Extend Access Token</strong>. This
            converts the short-lived token (1 hour) to long-lived (~60 days).
          </li>
          <li>Copy the long-lived token and paste it below.</li>
        </ol>
      </section>

      <form action={handleSubmit} className="bg-background space-y-4 rounded-lg border p-6">
        <div className="space-y-2">
          <label htmlFor="accessToken" className="text-sm font-medium">
            Long-lived access token
          </label>
          <div className="relative">
            <input
              id="accessToken"
              name="accessToken"
              type={reveal ? 'text' : 'password'}
              required
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 pr-10 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? 'Hide token' : 'Reveal token'}
              className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-muted-foreground text-xs">
            We encrypt this token at rest. It never appears in our logs.
          </p>
        </div>

        {error && (
          <div className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm">
            <p className="text-destructive font-medium">Token verification failed.</p>
            <p className="text-muted-foreground mt-1">{error}</p>
          </div>
        )}

        <VerifyButton />
      </form>
    </article>
  );
}
