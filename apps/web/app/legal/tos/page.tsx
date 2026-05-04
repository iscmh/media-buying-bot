export const metadata = { title: 'Terms of Service — Media Buying Bot' };

export default function ToSPage() {
  return (
    <main className="prose prose-neutral container mx-auto max-w-3xl px-4 py-12">
      <h1>Terms of Service (placeholder)</h1>
      <p className="text-muted-foreground text-sm">
        <strong>NOT LEGAL ADVICE. DO NOT USE IN PRODUCTION.</strong> This page is a stub. Final ToS
        will be written by counsel before any user signs up.
      </p>

      <h2>Liability protection (intent)</h2>
      <ul>
        <li>Customer is solely responsible for ad content and Meta policy compliance.</li>
        <li>
          Indemnification: customer holds the platform harmless for Meta enforcement actions against
          the customer&rsquo;s Meta accounts.
        </li>
        <li>
          Limitation of liability: max liability = 1 month subscription fee paid (which is $0 during
          MVP).
        </li>
        <li>
          Disclosure: Platform receives referral compensation from agency BM partners (FTC
          compliance).
        </li>
      </ul>
    </main>
  );
}
