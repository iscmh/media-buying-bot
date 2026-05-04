'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import type { RiskSection } from '@/lib/content/risk';
import { Button } from '@/components/ui/button';
import { acknowledgeRiskAction } from './actions';

interface RiskAcknowledgmentFormProps {
  sections: RiskSection[];
  ack1Label: string;
  ack2Label: string;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending} size="lg">
      {pending ? 'Saving…' : 'I understand. Continue.'}
    </Button>
  );
}

export function RiskAcknowledgmentForm({
  sections,
  ack1Label,
  ack2Label,
}: RiskAcknowledgmentFormProps) {
  const [scrolled, setScrolled] = React.useState(false);
  const [ack1, setAck1] = React.useState(false);
  const [ack2, setAck2] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setScrolled(true);
          observer.disconnect();
        }
      },
      { threshold: 0.01, rootMargin: '0px 0px -50px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  async function handleSubmit(formData: FormData) {
    setError(null);
    formData.set('scrolled', scrolled ? 'true' : 'false');
    const result = await acknowledgeRiskAction(formData);
    if (result?.error) setError(result.error);
  }

  const canSubmit = scrolled && ack1 && ack2;

  return (
    <>
      <div className="bg-card mb-6 space-y-6 rounded-lg border p-6 text-sm leading-relaxed">
        {sections.map((section, idx) => (
          <section key={section.heading}>
            <h2 className="mb-2 text-base font-semibold">{section.heading}</h2>
            {section.body.map((paragraph, i) => (
              <p key={i} className="text-foreground/90 mb-2 whitespace-pre-line last:mb-0">
                {paragraph}
              </p>
            ))}
            {idx === sections.length - 1 && <div ref={sentinelRef} aria-hidden="true" />}
          </section>
        ))}
      </div>

      <form action={handleSubmit} className="bg-background space-y-4 rounded-lg border p-6">
        <div
          className={
            scrolled
              ? 'space-y-3'
              : 'pointer-events-none space-y-3 opacity-50 [&_*]:cursor-not-allowed'
          }
          aria-disabled={!scrolled}
        >
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="ack1"
              checked={ack1}
              onChange={(e) => setAck1(e.target.checked)}
              disabled={!scrolled}
              className="border-input mt-1 h-4 w-4 rounded"
            />
            <span>{ack1Label}</span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="ack2"
              checked={ack2}
              onChange={(e) => setAck2(e.target.checked)}
              disabled={!scrolled}
              className="border-input mt-1 h-4 w-4 rounded"
            />
            <span>{ack2Label}</span>
          </label>
        </div>

        {!scrolled && (
          <p className="text-muted-foreground text-xs">
            Scroll through the entire risk education above to enable the acknowledgment.
          </p>
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}

        <SubmitButton disabled={!canSubmit} />
      </form>
    </>
  );
}
