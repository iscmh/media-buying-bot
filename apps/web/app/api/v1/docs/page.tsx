import Link from 'next/link';

export const metadata = { title: 'Ads Bot API v1' };
export const dynamic = 'force-static';

/**
 * Polish-25.10 Commit 59: /api/v1/docs — public API reference.
 * Middleware whitelists /api/v1 so this page is reachable without
 * a session cookie. Uses plain HTML (no AppShell) so unauthenticated
 * visitors don't hit any authed data-fetch.
 */
export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 text-sm">
      <div className="mb-6">
        <Link href="/dashboard" className="text-xs uppercase tracking-wide underline">
          ← Back to dashboard
        </Link>
      </div>

      <h1 className="text-2xl font-semibold">Ads Bot API v1</h1>
      <p className="text-fg-muted mt-2">
        REST API for driving the creative pipeline programmatically. Scale-tier feature.
      </p>

      <Section title="Base URL">
        <Code>https://ads-bot-ten.vercel.app/api/v1</Code>
      </Section>

      <Section title="Authentication">
        <p>
          All endpoints require a Bearer token in the <Mono>Authorization</Mono> header. Generate a
          key at <Mono>/settings/api</Mono>.
        </p>
        <Code>{`Authorization: Bearer sk_live_YOUR_KEY_HERE`}</Code>
        <p className="text-fg-muted">
          Each key has full account access. Treat it like a password. Rotate via the same page.
        </p>
      </Section>

      <Section title="Rate limits">
        <p>
          60 requests per 60-second sliding window per API key. Over-the-limit responses set{' '}
          <Mono>Retry-After</Mono>, <Mono>X-RateLimit-Limit</Mono>, and{' '}
          <Mono>X-RateLimit-Remaining</Mono> headers.
        </p>
      </Section>

      <Section title="Response envelope">
        <p>Success:</p>
        <Code>{`{ "data": { ... } }`}</Code>
        <p className="mt-2">Failure:</p>
        <Code>{`{ "error": { "code": "validation_error", "message": "...", "details": { ... } } }`}</Code>
        <p className="text-fg-muted">
          Status codes: <Mono>200</Mono> ok, <Mono>201</Mono> created, <Mono>202</Mono> accepted,{' '}
          <Mono>401</Mono> unauthorized, <Mono>403</Mono> forbidden, <Mono>404</Mono> not found,{' '}
          <Mono>409</Mono> conflict, <Mono>422</Mono> validation error, <Mono>429</Mono> rate
          limited, <Mono>500</Mono> internal.
        </p>
      </Section>

      <Section title="Concepts">
        <Endpoint method="POST" path="/concepts">
          <p>
            Upload a source ad. Fetches <Mono>source_url</Mono> server-side and stores it under your
            account. Max 10MB (static images) / 100MB (UGC videos).
          </p>
          <Code>{`{
  "source_url": "https://example.com/creative.mp4",
  "content_type": "ugc",         // "static" | "ugc"
  "name": "Winner 3.2",          // optional
  "niche_tag": "nutra",          // optional
  "offer_url": "https://..."     // optional
}`}</Code>
        </Endpoint>
        <Endpoint method="GET" path="/concepts?limit=50&offset=0">
          <p>List your concepts, newest first.</p>
        </Endpoint>
        <Endpoint method="GET" path="/concepts/:id">
          <p>Get a concept + its analysis metadata.</p>
        </Endpoint>
      </Section>

      <Section title="Generations">
        <Endpoint method="POST" path="/generations">
          <p>Fire a generation job. Cost is estimated + capped server-side per your daily limit.</p>
          <Code>{`{
  "concept_id": "uuid",
  "variants": 5,
  "intensity": "medium",                       // "small" | "medium" | "big"
  "pipeline": "static_openai_image",           // optional, see /pipelines list
  "mode": "live",                              // "mock" | "live" (mock = free)
  "static_openai_quality": "medium"            // optional, static_openai_image only
}`}</Code>
        </Endpoint>
        <Endpoint method="GET" path="/generations?status=completed&limit=50">
          <p>
            List your generations. <Mono>status</Mono> is one of queued / in_progress / completed /
            failed / cancelled.
          </p>
        </Endpoint>
        <Endpoint method="GET" path="/generations/:id">
          <p>Get a generation + all its variants (real ROAS lives on launched_ads, not here).</p>
        </Endpoint>
        <Endpoint method="POST" path="/generations/:id/variants/:variant_id/approve">
          <p>Approve a variant. Idempotent.</p>
        </Endpoint>
        <Endpoint method="POST" path="/generations/:id/variants/:variant_id/reject">
          <p>Reject a variant. Idempotent.</p>
        </Endpoint>
      </Section>

      <Section title="Launches">
        <Endpoint method="POST" path="/launches">
          <p>
            Launch every approved variant on a generation to Meta as paused ads. Same safety
            envelope as the web launch: daily budget cap, first-live cap, page validation.
          </p>
          <Code>{`{
  "generation_id": "uuid",
  "mode": "live",                          // "mock" | "live"
  "page_id": "1234567890",                 // required for live
  "offer_url": "https://your-offer.com",   // required for live
  "targeting_countries": ["US"],
  "age_min": 25,
  "age_max": 55,
  "per_ad_budget_usd": 20
}`}</Code>
          <p className="text-fg-muted">
            First live launch requires you to have completed the acknowledgement dialog once in the
            web UI. Same for the first live generation.
          </p>
        </Endpoint>
      </Section>

      <Section title="Launched ads">
        <Endpoint method="GET" path="/launched_ads?status=active&limit=50">
          <p>List your launched ads with real ROAS + spend/impressions/clicks/conversions.</p>
        </Endpoint>
        <Endpoint method="POST" path="/launched_ads/:id/kill">
          <p>
            Kill an ad (Meta pause). Routes through the approvals table so audit + retry semantics
            match the web action.
          </p>
        </Endpoint>
        <Endpoint method="POST" path="/launched_ads/:id/scale">
          <p>Scale an ad's daily budget. Platform scale caps enforced server-side.</p>
          <Code>{`{ "new_budget_usd": 40 }`}</Code>
        </Endpoint>
      </Section>

      <Section title="Presets">
        <Endpoint method="GET" path="/presets">
          <p>List your saved launch presets (targeting, budget, optimization goal bundles).</p>
        </Endpoint>
      </Section>

      <Section title="Quick example (curl)">
        <Code>{`# 1. Upload a concept from a URL
curl https://ads-bot-ten.vercel.app/api/v1/concepts \\
  -H "Authorization: Bearer $ADS_BOT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"source_url":"https://example.com/creative.mp4","content_type":"ugc"}'

# 2. Fire a generation
curl https://ads-bot-ten.vercel.app/api/v1/generations \\
  -H "Authorization: Bearer $ADS_BOT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"concept_id":"<from-step-1>","variants":5,"mode":"live"}'

# 3. Poll status
curl https://ads-bot-ten.vercel.app/api/v1/generations/<id> \\
  -H "Authorization: Bearer $ADS_BOT_KEY"

# 4. Approve variants + launch to Meta
curl -X POST https://ads-bot-ten.vercel.app/api/v1/generations/<id>/variants/<vid>/approve \\
  -H "Authorization: Bearer $ADS_BOT_KEY"

curl -X POST https://ads-bot-ten.vercel.app/api/v1/launches \\
  -H "Authorization: Bearer $ADS_BOT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"generation_id":"<id>","mode":"live","page_id":"...","offer_url":"https://..."}'`}</Code>
      </Section>

      <Section title="Quick example (JS)">
        <Code>{`const API_KEY = process.env.ADS_BOT_KEY;
const BASE = 'https://ads-bot-ten.vercel.app/api/v1';

async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Authorization': 'Bearer ' + API_KEY,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? res.statusText);
  return body.data;
}

// Upload + generate + launch
const concept = await call('/concepts', {
  method: 'POST',
  body: JSON.stringify({
    source_url: 'https://example.com/creative.mp4',
    content_type: 'ugc',
  }),
});
const gen = await call('/generations', {
  method: 'POST',
  body: JSON.stringify({ concept_id: concept.id, variants: 5, mode: 'live' }),
});
console.log('Queued generation', gen.id);`}</Code>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-fg mb-2 text-lg font-semibold">{title}</h2>
      <div className="text-fg space-y-3">{children}</div>
    </section>
  );
}

function Endpoint({
  method,
  path,
  children,
}: {
  method: string;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border-subtle mt-3 border-l-2 pl-3">
      <div className="mb-1 font-mono text-xs">
        <span className="text-fg font-semibold">{method}</span>{' '}
        <span className="text-fg-muted">{path}</span>
      </div>
      <div className="text-fg-muted space-y-2 text-sm">{children}</div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-panel border-border overflow-x-auto rounded border p-3 font-mono text-xs">
      {children}
    </pre>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-panel border-border rounded border px-1 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
}
