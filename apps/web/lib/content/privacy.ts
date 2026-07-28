/**
 * Privacy Policy content. Rendered at /legal/privacy (public,
 * read-only). Tone matches TOS: operator-honest, plain English, no
 * corporate legalese. Same "counsel review pending before paid tiers"
 * hedge as TOS, mirrored on this page for the same reason.
 *
 * Bump `PRIVACY_VERSION` in `@mbb/shared` when the substance of any
 * section changes.
 */

export interface PrivacySection {
  heading: string;
  body: string[];
}

export const PRIVACY_SECTIONS: PrivacySection[] = [
  {
    heading: 'What this policy covers',
    body: [
      'This policy explains what data Ads Bot stores, why we store it, how long we keep it, who can see it, and how you can remove it. It applies to everything you do on the platform after you sign up.',
    ],
  },
  {
    heading: 'What we collect',
    body: [
      'Account information: your email address and (when you sign in with Google) the OAuth identifier Google returns. We use this to authenticate you and address transactional messages.',
      "API keys you paste (Claude, Gemini, and any optional providers you enable): stored encrypted in Supabase Vault. We use them only to make API calls on your behalf, from server-side code you don't control. They are never sent to your browser after you save them, and we don't share them with any third party.",
      'Meta credentials you paste (long-lived access token, selected Business Manager ID, selected ad account IDs, selected Page IDs, currency and timezone metadata Meta returns): stored encrypted. Used only to make Meta Graph API calls on your behalf. See the ToS for the details of what those calls do.',
      'Concepts you upload (source ads, images, videos, headlines, primary text, offer URLs, niche tags): stored in Supabase Storage. Used to generate variants and, if you launch them, to send to Meta.',
      'Generated variants (images, videos, headlines, primary text) and the Meta objects created when you launch them (campaign IDs, ad set IDs, ad IDs, dry-run placeholders). Used to render your dashboard and to power the kill/scale automation.',
      'Ad performance data returned by Meta (spend, impressions, clicks, conversions, budgets, timestamps). Fetched on a polling cadence. Used to render your dashboard and to evaluate kill/scale rules.',
      'Application logs: audit records of significant actions (launches, kills, scales, approvals, connection changes, pauses). Used for debugging, safety review, and account recovery.',
      "Support messages you send us and our responses. We don't automatically scrape your account beyond what's above.",
    ],
  },
  {
    heading: 'What we do NOT collect',
    body: [
      "We don't ask for your Meta password. We don't ask for your Google password. We don't require access to your personal Facebook profile beyond the scopes you granted your own Meta Developer App.",
      "We don't run third-party analytics trackers (no Google Analytics, no Segment, no Mixpanel, no Facebook Pixel) on the authenticated part of the app. We do run first-party error-monitoring via Sentry so we can debug crashes; Sentry receives error stack traces and the URL you were on, not the contents of your ads.",
      "We don't sell any data. We don't share data with advertisers. Bring-your-own-key is the model — your data reaches OpenAI/Anthropic/Google/Meta because you paid those companies directly and told us to route calls to them.",
    ],
  },
  {
    heading: 'How we use it',
    body: [
      'To orchestrate API calls to the providers you connected (Claude for copy, Gemini for vision, Meta for launches). Every call is initiated by an action you took or by a rule you configured.',
      'To render your dashboard, run summaries, launched-ad tables, and pending-approval queues.',
      "To evaluate the kill/scale rules you configured and — when the platform detects a rule condition — to either auto-execute (if you've opted in for a given rule) or to record a pending approval you can act on from the web UI.",
      'To send transactional email (login links, security notices, and — if you enable it — daily P&L summaries) via the email provider that ships with your Supabase project.',
      'To audit-log actions so both you and we can reconstruct what happened if something goes wrong.',
    ],
  },
  {
    heading: 'How long we keep it',
    body: [
      'While your account is active: all the data above stays for as long as you have an account so the app keeps working. You can delete concepts and disconnect providers at any time from the app; those actions soft-delete the underlying rows and stop the platform from using them, but we keep the tombstone for 30 days for account recovery in case you deleted something by mistake.',
      'After you delete your account: we hard-delete every row keyed to your user_id within 30 days of the deletion request. Audit-log entries are retained for 12 months in redacted form (user_id replaced with a random opaque identifier) so we can debug abuse or security incidents that surface after the fact. Encrypted API keys and Meta tokens are hard-deleted with everything else; they cannot be recovered.',
    ],
  },
  {
    heading: 'Your rights',
    body: [
      "Export: you can request a machine-readable dump of every row keyed to your user_id. Reach out via the contact channel below and we'll ship it within 14 days.",
      'Delete account: request account deletion via the contact channel below or via /settings once we ship the in-app version. Hard delete within 30 days as described above.',
      "Revoke Meta access: revoke the OAuth grant from your Meta Business Manager or from the Meta Developer Console — that instantly breaks our ability to call Meta on your behalf, regardless of whether you've deleted the account here.",
      'Revoke provider keys: rotate any API key on the provider side (Anthropic, Google AI Studio, OpenAI, etc.) — that instantly breaks our ability to spend on your behalf. Then remove the key from the app via Settings → Connections.',
    ],
  },
  {
    heading: 'Who has access',
    body: [
      'Access to the production database is restricted to the operator + one on-call engineer. Access is logged. We only look at your rows to debug an issue you reported or a security incident we detected.',
      'We do not have a "customer success" team, an "analytics" team, or any other party inside or outside the company that reads customer data as part of a normal workflow. Support contact for the platform is the operator directly.',
    ],
  },
  {
    heading: 'Where the data lives',
    body: [
      'The application database is Postgres hosted on Supabase (US region). The object store for concepts + generated variants is Supabase Storage (US region). Application code runs on Vercel (US region). Long-running jobs run on Inngest (US region).',
      'When you make an ad-related request, the payload is sent to Meta (whatever region Meta serves that BM from) and to whichever AI provider you configured (Claude and Gemini currently, both US-hosted; optional providers may be elsewhere per their documentation).',
      "If you're accessing the app from outside the US, your data is processed in the US by the systems above. If that's a blocker for you, don't sign up.",
    ],
  },
  {
    heading: 'Cookies',
    body: [
      'We set one session cookie via Supabase Auth so you stay logged in. We set one UI preference cookie (`sidebar_collapsed`) that remembers whether the nav rail is open. Neither cookie is used for tracking, retargeting, or analytics. We do not set any third-party cookies.',
    ],
  },
  {
    heading: 'Encryption',
    body: [
      'API keys and Meta access tokens are encrypted with AES-256-GCM before writing to Postgres, using Supabase Vault as the KMS layer. The plaintext key material is never logged and never sent back to your browser once saved. Only the server-side workers that make outbound API calls decrypt these secrets at request time.',
      "Data in transit uses TLS 1.2 or higher everywhere. HTTPS on the app, HTTPS or the vendor's native TLS for every outbound API call.",
    ],
  },
  {
    heading: 'Meta enforcement, aggressive verticals, and this policy',
    body: [
      "The ToS is explicit that Meta enforcement risk in MMO/biz-opp/nutra/finance is real and the risk is yours. Nothing in this Privacy Policy changes that: we don't share your ads or your Meta activity with Meta beyond what your own launches inherently share (that's what a launch is), we don't tip Meta off about your account, and we don't proactively report you to anyone. But Meta can and does inspect what you launch. Their access to your ad content is Meta's, not ours.",
    ],
  },
  {
    heading: 'Security incidents',
    body: [
      "If we experience a security incident that materially affects data keyed to your user_id, we notify you at the email on file within 72 hours of confirmation, with what we know and what we don't. We publish incident post-mortems at the contact channel below.",
    ],
  },
  {
    heading: 'Changes to this policy',
    body: [
      'When we materially change this policy we bump the version at the top of the page, notify signed-up users by email, and — for material changes — surface an in-app banner until you acknowledge the update.',
    ],
  },
  {
    heading: 'Contact',
    body: [
      "The fastest way to reach us is via the operator email on file at the domain hosting this app. If you're a user, that's the email address we replied to when you first signed up. For data-subject requests (export, delete), use the same channel and include your account email so we can identify the rows to act on.",
    ],
  },
];

export const PRIVACY_DISCLOSURE_BANNER =
  "This is the operator-drafted policy. It reflects how the platform actually works today. Formal legal review is scheduled before we open paid tiers; substance won't change but wording may.";
