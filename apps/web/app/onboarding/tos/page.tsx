import { TOS_VERSION } from '@mbb/shared';
import { TOS_DISCLOSURE_BANNER, TOS_SECTIONS } from '@/lib/content/tos';
import { requireOnboardingStep } from '@/lib/onboarding-gate';
import { TosAcceptForm } from './tos-form';

export const metadata = { title: 'Terms' };

export default async function OnboardingTosPage() {
  await requireOnboardingStep('tos');

  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Terms of Service & Risk Acknowledgment</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Version {TOS_VERSION}. {TOS_DISCLOSURE_BANNER}
        </p>
      </header>

      <div className="bg-card space-y-6 rounded-lg border p-6 text-sm leading-relaxed">
        {TOS_SECTIONS.map((section) => (
          <section key={section.heading}>
            <h2 className="mb-2 text-base font-semibold">{section.heading}</h2>
            {section.body.map((paragraph, i) => (
              <p key={i} className="text-foreground/90 mb-2 last:mb-0">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </div>

      <TosAcceptForm />
    </article>
  );
}
