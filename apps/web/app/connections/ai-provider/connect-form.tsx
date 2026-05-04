'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Eye, EyeOff } from 'lucide-react';
import { AI_PROVIDER_META, type AIProviderName } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { verifyAndSaveProviderKey } from './actions';

const ORDER: AIProviderName[] = ['arcads', 'heygen', 'creatify'];

function VerifyButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} size="lg">
      {pending ? 'Verifying…' : 'Verify and save'}
    </Button>
  );
}

export function ProviderConnectForm() {
  const [provider, setProvider] = React.useState<AIProviderName>('arcads');
  const [apiKey, setApiKey] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(formData: FormData) {
    setError(null);
    const result = await verifyAndSaveProviderKey(formData);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Verification failed.');
      return;
    }
    if (typeof window !== 'undefined') window.location.reload();
  }

  const selectedMeta = AI_PROVIDER_META[provider];

  return (
    <form action={handleSubmit} className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Choose a provider</legend>
        {ORDER.map((p) => {
          const meta = AI_PROVIDER_META[p];
          const isSelected = provider === p;
          return (
            <label
              key={p}
              className={
                'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ' +
                (isSelected ? 'border-primary bg-primary/5' : 'bg-card hover:bg-accent/30')
              }
            >
              <input
                type="radio"
                name="provider"
                value={p}
                checked={isSelected}
                onChange={() => setProvider(p)}
                className="mt-1 h-4 w-4"
              />
              <span className="flex-1">
                <span className="block font-semibold">{meta.label}</span>
                <span className="text-muted-foreground block text-sm">{meta.description}</span>
                <span className="mt-1 block text-xs">
                  <a href={meta.pricingUrl} target="_blank" rel="noreferrer" className="underline">
                    Pricing
                  </a>
                  {' · '}
                  <a href={meta.apiDocsUrl} target="_blank" rel="noreferrer" className="underline">
                    API docs
                  </a>
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="apiKey">API key</Label>
        <div className="relative">
          <input
            id="apiKey"
            name="apiKey"
            type={reveal ? 'text' : 'password'}
            required
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 pr-10 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? 'Hide key' : 'Reveal key'}
            className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
          >
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <KeyHint provider={provider} />
        <p className="text-muted-foreground text-xs">
          {selectedMeta.verificationMethod === 'api'
            ? "We'll call the provider to confirm this key works before saving."
            : "We'll validate the key's format here. Real verification happens at first generation — this is a known limitation of the provider's public docs."}
        </p>
      </div>

      <Input type="hidden" name="provider" value={provider} />

      {error && (
        <div className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm">
          <p className="text-destructive font-medium">Verification failed.</p>
          <p className="text-muted-foreground mt-1">{error}</p>
        </div>
      )}

      <VerifyButton />
    </form>
  );
}

function KeyHint({ provider }: { provider: AIProviderName }) {
  if (provider === 'creatify') {
    return (
      <p className="text-muted-foreground text-xs">
        Creatify uses two credentials. Find them in your Creatify account → API Dashboard → Show API
        Keys, then paste them joined as <code className="font-mono">API_ID:API_KEY</code>.
      </p>
    );
  }
  if (provider === 'arcads') {
    return (
      <p className="text-muted-foreground text-xs">
        Generate credentials in Arcads → Settings → Public API. If Arcads gives you a Client ID and
        Client Secret, paste them joined as{' '}
        <code className="font-mono">CLIENT_ID:CLIENT_SECRET</code>.
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-xs">
      Find your HeyGen API key under Settings → API. Paste the single value here.
    </p>
  );
}
