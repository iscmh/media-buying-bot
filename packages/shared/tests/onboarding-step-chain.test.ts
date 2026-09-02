/**
 * Polish-29.0.8 Commit 117 regression pin: onboarding step chain.
 *
 * History:
 *   pre-10a  → 4 steps (tos → risk → meta → telegram)
 *   10a      → 3 steps (tos → risk → keys), meta+telegram opt-in
 *   Commit 117 → 2 steps (tos → risk), `keys` dropped because the
 *                default video generation path is now credit-backed
 *                Seedance (no BYOK keys required for first video).
 *
 * This test fails loudly if a future edit silently re-adds meta /
 * telegram / keys to the REQUIRED chain. BYOK is still an opt-in
 * surface at /settings/connections — it just doesn't gate signup.
 */
import { describe, expect, it } from 'vitest';
import type { OnboardingStep } from '../src/onboarding';
import { ONBOARDING_STEPS, ONBOARDING_STEP_LABELS, ONBOARDING_STEP_PATHS } from '../src/onboarding';

describe('Polish-29.0.8 Commit 117: onboarding chain', () => {
  it('has exactly 2 steps: tos → risk', () => {
    expect([...ONBOARDING_STEPS]).toEqual(['tos', 'risk']);
  });

  it('does NOT include meta / telegram / keys as required steps', () => {
    // Cast because 'meta' / 'telegram' / 'keys' are no longer in the
    // OnboardingStep union — the assertion is that the READ-ONLY
    // ONBOARDING_STEPS tuple doesn't contain them even at runtime.
    const asString = ONBOARDING_STEPS as readonly string[];
    expect(asString).not.toContain('meta');
    expect(asString).not.toContain('telegram');
    expect(asString).not.toContain('keys');
  });

  it('every step has a matching path + label', () => {
    for (const step of ONBOARDING_STEPS) {
      const s: OnboardingStep = step;
      expect(ONBOARDING_STEP_PATHS[s]).toMatch(/^\/onboarding\/[a-z]+$/);
      expect(ONBOARDING_STEP_LABELS[s]).toBeTruthy();
    }
  });

  it('tos step routes to /onboarding/tos', () => {
    expect(ONBOARDING_STEP_PATHS.tos).toBe('/onboarding/tos');
  });

  it('risk step routes to /onboarding/risk', () => {
    expect(ONBOARDING_STEP_PATHS.risk).toBe('/onboarding/risk');
  });
});
