/**
 * Polish-25.1 Commit 10a regression pin: onboarding step chain.
 *
 * Chain was 4 steps (tos → risk → meta → telegram) pre-Commit-10a.
 * Commit 10a drops meta + telegram (they became opt-in surfaces at
 * /settings/connections) and adds `keys` (BYOK required for the
 * Polish-25 default flow). This pin fails loudly if a future edit
 * silently re-adds meta / telegram to the required chain or drops
 * the `keys` step.
 */
import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, ONBOARDING_STEP_LABELS, ONBOARDING_STEP_PATHS } from '../src/onboarding';

describe('Polish-25.1 Commit 10a: onboarding chain', () => {
  it('has exactly 3 steps: tos → risk → keys', () => {
    expect([...ONBOARDING_STEPS]).toEqual(['tos', 'risk', 'keys']);
  });

  it('does NOT include meta or telegram as required steps', () => {
    expect(ONBOARDING_STEPS).not.toContain('meta');
    expect(ONBOARDING_STEPS).not.toContain('telegram');
  });

  it('every step has a matching path + label', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(ONBOARDING_STEP_PATHS[step]).toMatch(/^\/onboarding\/[a-z]+$/);
      expect(ONBOARDING_STEP_LABELS[step]).toBeTruthy();
    }
  });

  it('keys step routes to /onboarding/keys', () => {
    expect(ONBOARDING_STEP_PATHS.keys).toBe('/onboarding/keys');
  });

  it('keys label is human-readable', () => {
    expect(ONBOARDING_STEP_LABELS.keys).toBe('Keys');
  });
});
