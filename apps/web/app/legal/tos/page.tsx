import { TOS_VERSION } from '@mbb/shared';
import { TOS_DISCLOSURE_BANNER, TOS_SECTIONS } from '@/lib/content/tos';

export const metadata = { title: 'Terms of Service' };

/**
 * Publicly-readable canonical ToS. Same content source as /onboarding/tos
 * (no checkbox here — that's the gated acceptance flow). Bumping
 * TOS_VERSION updates both pages and triggers re-acceptance for existing
 * users on next login.
 */
export default function ToSPage() {
  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-4xl font-bold">Terms of Service</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Version {TOS_VERSION}. {TOS_DISCLOSURE_BANNER}
        </p>
      </header>

      <article className="space-y-6 text-sm leading-relaxed">
        {TOS_SECTIONS.map((section) => (
          <section key={section.heading}>
            <h2 className="mb-2 text-lg font-semibold">{section.heading}</h2>
            {section.body.map((paragraph, i) => (
              <p key={i} className="text-foreground/90 mb-2 last:mb-0">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </article>
    </main>
  );
}
