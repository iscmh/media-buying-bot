import { RISK_ACKNOWLEDGMENT_LABELS, RISK_SECTIONS } from '@/lib/content/risk';
import { requireOnboardingStep } from '@/lib/onboarding-gate';
import { RiskAcknowledgmentForm } from './risk-form';

export const metadata = { title: 'Risk Acknowledgment' };

export default async function OnboardingRiskPage() {
  await requireOnboardingStep('risk');

  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Read this before connecting Meta</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Five sections. Scroll to the bottom. The acknowledgment unlocks once you have.
        </p>
      </header>

      <RiskAcknowledgmentForm
        sections={RISK_SECTIONS}
        ack1Label={RISK_ACKNOWLEDGMENT_LABELS.ack1}
        ack2Label={RISK_ACKNOWLEDGMENT_LABELS.ack2}
      />
    </article>
  );
}
