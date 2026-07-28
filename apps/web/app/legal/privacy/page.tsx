import { PRIVACY_VERSION } from '@mbb/shared';
import { PRIVACY_DISCLOSURE_BANNER, PRIVACY_SECTIONS } from '@/lib/content/privacy';

export const metadata = { title: 'Privacy Policy' };

/**
 * Polish-25.6 Commit 34: real Privacy Policy (was a placeholder).
 * Publicly readable, no auth. Source of record is
 * `apps/web/lib/content/privacy.ts`. Version tracked in `@mbb/shared`
 * so we can bump it without touching the render component.
 *
 * Tone-matched to `/legal/tos`: operator-honest, plain English, same
 * "counsel-review-pending-before-paid-tiers" disclosure banner so a
 * buyer reading this side by side with the ToS gets a consistent
 * signal.
 */
export default function PrivacyPage() {
  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <header className="mb-6">
        <h1 className="text-fg text-4xl font-bold">Privacy Policy</h1>
        <p className="text-fg-muted mt-2 text-sm">
          Version {PRIVACY_VERSION}. {PRIVACY_DISCLOSURE_BANNER}
        </p>
      </header>

      <article className="space-y-6 text-sm leading-relaxed">
        {PRIVACY_SECTIONS.map((section) => (
          <section key={section.heading}>
            <h2 className="text-fg mb-2 text-lg font-semibold">{section.heading}</h2>
            {section.body.map((paragraph, i) => (
              <p key={i} className="text-fg/90 mb-2 last:mb-0">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </article>
    </main>
  );
}
