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

/**
 * Polish-28.4.9 Commit 107: Meta OAuth entry-point button. Rendered
 * only when META_APP_ID + META_APP_SECRET are configured on the deploy
 * (the `oauthEnabled` prop). Points at /api/auth/meta/start which
 * handles the CSRF cookie + redirect to Meta's OAuth consent screen.
 */
interface MetaTokenPasteFormProps {
  oauthEnabled?: boolean;
  oauthError?: string | null;
}

export function MetaTokenPasteForm({
  oauthEnabled = false,
  oauthError = null,
}: MetaTokenPasteFormProps = {}) {
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [reveal, setReveal] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [warning, setWarning] = React.useState<string | null>(null);
  const [token, setToken] = React.useState('');

  async function handleSubmit(formData: FormData) {
    setError(null);
    setWarning(null);
    const result = await verifyMetaTokenAction(formData);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Verification failed.');
      return;
    }
    if (result.warning) {
      setWarning(result.warning);
      // Don't reload immediately when there's a warning — let the
      // operator read it. They can click Continue to proceed to the
      // BM picker.
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
          You provide your own Meta access token. We verify it, encrypt it, and store the
          ciphertext. We never see your Facebook password.
        </p>
      </header>

      {oauthError && (
        <section
          className="border-[color:var(--accent-negative)]/40 bg-[color:var(--accent-negative)]/5 mb-6 rounded-md border p-4 text-sm leading-relaxed"
          role="note"
        >
          <p className="text-fg font-semibold">Meta login didn&apos;t complete</p>
          <p className="text-fg-muted mt-1 font-mono text-xs">Reason: {oauthError}</p>
          <p className="text-fg-muted mt-2">
            {oauthError.startsWith('denied')
              ? 'You (or Meta) cancelled the consent screen. Try again, or use a paste-token path below.'
              : oauthError === 'state_mismatch'
                ? 'Session mismatch — your browser cookie for the OAuth flow expired or was blocked. Try again from a normal (non-incognito) tab.'
                : oauthError === 'not_configured'
                  ? "This deploy doesn't have META_APP_ID / META_APP_SECRET set. Use a paste-token path below."
                  : 'Try again, or fall back to one of the paste-token paths below.'}
          </p>
        </section>
      )}

      {/* Polish-28.4.9 Commit 107: primary path is now Log in with Meta.
          Hidden when META_APP_ID/SECRET are not configured on the deploy. */}
      {oauthEnabled ? (
        <section className="bg-card mb-6 space-y-3 rounded-lg border p-6 text-sm leading-relaxed">
          <h2 className="text-base font-semibold">Recommended: Log in with Meta</h2>
          <p className="text-fg-muted">
            One-click OAuth. Meta shows you the consent screen; approve the requested permissions;
            we get a scoped token and store it encrypted. No fraud alarm, no manual token
            generation.
          </p>
          <p className="text-fg-muted text-xs">
            While the Meta App is in Development mode, only pre-added Testers can log in. Ask the
            operator to add your Facebook profile as a Tester at
            developers.facebook.com/apps/&lt;app id&gt;/roles/roles/ before clicking below. After
            Meta App Review approval, any user can log in here.
          </p>
          <a
            href="/api/auth/meta/start"
            className="inline-flex h-11 items-center justify-center rounded-md bg-[#1877f2] px-5 text-sm font-semibold text-white hover:bg-[#166fe0]"
          >
            Log in with Meta
          </a>
        </section>
      ) : (
        <section
          className="border-[color:var(--accent-warning)]/40 bg-[color:var(--accent-warning)]/5 mb-6 rounded-md border p-4 text-sm leading-relaxed"
          role="note"
        >
          <p className="text-fg font-semibold">
            One-click &quot;Log in with Meta&quot; is disabled on this deploy
          </p>
          <p className="text-fg-muted mt-2">
            To enable it, the operator sets <code className="font-mono">META_APP_ID</code> and{' '}
            <code className="font-mono">META_APP_SECRET</code> on the Vercel env (from a
            Business-type app at developers.facebook.com/apps → Settings → Basic). Until then, use
            one of the token-paste paths below.
          </p>
        </section>
      )}

      <div className="mb-6">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-primary text-sm underline underline-offset-4 hover:no-underline"
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced: paste a token manually
        </button>
      </div>

      {/* Polish-28.4.8 Commit 106 + Polish-28.4.9 Commit 107: paste-token
          paths collapsed under the Advanced toggle above. Kept as a
          fallback for operators whose Meta App can't accept them as a
          Tester yet, or for CLI / API v1 callers. */}
      {!showAdvanced ? null : (
        <>
          <section
            className="border-[color:var(--accent-warning)]/40 bg-[color:var(--accent-warning)]/5 mb-6 rounded-md border p-4 text-sm leading-relaxed"
            role="note"
          >
            <p className="text-fg font-semibold">Advanced: pick the right kind of token.</p>
            <p className="text-fg-muted mt-2">
              Meta&apos;s fraud detection treats a personal-account token being used from a server
              as a hacked account, and prompts you to reset your Facebook password. Avoid this by
              generating a <strong>System User token</strong> from Meta Business Manager instead of
              a personal token from the Graph API Explorer. System User tokens are what Meta expects
              third-party apps to use — no fraud alarm, no expiry.
            </p>
          </section>

          <section className="bg-card mb-6 space-y-4 rounded-lg border p-6 text-sm leading-relaxed">
            <h2 className="text-base font-semibold">
              Recommended: System User token (~10 minutes, no expiry, no fraud alarm)
            </h2>
            <ol className="list-inside list-decimal space-y-2">
              <li>
                Open{' '}
                <a
                  href="https://business.facebook.com/settings/system-users"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  business.facebook.com/settings/system-users
                </a>
                . If prompted, pick the Business Manager that owns the ad account you want to launch
                ads on.
              </li>
              <li>
                Click <strong>Add</strong>, name the system user (e.g. &quot;MBB Bot&quot;), pick
                role <strong>Admin</strong>, then <strong>Create</strong>.
              </li>
              <li>
                With the new system user selected, click <strong>Add Assets</strong> →{' '}
                <strong>Ad Accounts</strong> → tick the ad account(s) you want to use → give it{' '}
                <strong>Manage ad account</strong> permission → <strong>Save</strong>. Repeat for{' '}
                <strong>Pages</strong> (permission: <strong>Manage Page</strong>).
              </li>
              <li>
                Click <strong>Generate New Token</strong>. Pick the Meta Developer App the token
                belongs to (create a blank Business-type app under{' '}
                <a
                  href="https://developers.facebook.com/apps/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  developers.facebook.com/apps
                </a>{' '}
                if you don&apos;t have one yet).
              </li>
              <li>
                Set token expiration to <strong>Never</strong>. Select all required scopes:
                <ul className="ml-5 mt-2 list-disc space-y-1 font-mono text-xs">
                  {META_REQUIRED_SCOPES.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </li>
              <li>Copy the generated token and paste it below.</li>
            </ol>
          </section>

          <section className="bg-card mb-6 space-y-3 rounded-lg border p-6 text-sm leading-relaxed">
            <h2 className="text-base font-semibold">
              Fallback: Personal USER token (quick, but Meta may lock your account)
            </h2>
            <p className="text-fg-muted">
              Fine for a single-operator test. Not recommended for real use — Meta&apos;s fraud
              alarm fires on first server-side call and asks you to reset your Facebook password.
            </p>
            <ol className="list-inside list-decimal space-y-2">
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
                , pick a Business-type app, and click <strong>Generate Access Token</strong>.
              </li>
              <li>Select all required scopes (list above).</li>
              <li>
                Click the <em>info icon</em> → <strong>Open in Access Token Tool</strong> →{' '}
                <strong>Extend Access Token</strong> (extends short-lived → ~60-day long-lived).
              </li>
              <li>Copy the long-lived token and paste it below.</li>
            </ol>
          </section>
        </>
      )}

      {showAdvanced && (
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

          {warning && (
            <div
              className="border-[color:var(--accent-warning)]/50 bg-[color:var(--accent-warning)]/5 rounded-md border p-3 text-sm"
              role="note"
            >
              <p className="text-fg font-medium">Token accepted — but read this:</p>
              <p className="text-fg-muted mt-1">{warning}</p>
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== 'undefined') window.location.reload();
                }}
                className="text-primary mt-2 text-xs underline underline-offset-4"
              >
                Continue anyway (I&apos;ll deal with the fraud prompt)
              </button>
            </div>
          )}

          <VerifyButton />
        </form>
      )}
    </article>
  );
}
