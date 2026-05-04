import { z } from 'zod';

export const ONBOARDING_STEPS = ['tos', 'risk', 'meta', 'telegram'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Human labels for the wizard progress bar. */
export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  tos: 'Terms',
  risk: 'Risk',
  meta: 'Meta',
  telegram: 'Telegram',
};

/** Map step → URL path. Single source of truth for redirects. */
export const ONBOARDING_STEP_PATHS: Record<OnboardingStep, string> = {
  tos: '/onboarding/tos',
  risk: '/onboarding/risk',
  meta: '/onboarding/meta',
  telegram: '/onboarding/telegram',
};

/**
 * Required scopes on the user's Meta long-lived token. Verified on
 * onboarding paste — missing scopes fail the verify step with a list of
 * what's missing. We require all five up front so the user never has to
 * regenerate a token mid-build:
 *  - ads_management        — create/update/delete ads (Phase 4)
 *  - ads_read              — read ad performance (Phase 5)
 *  - business_management   — list/select BMs (Phase 2a)
 *  - pages_show_list       — bind ads to FB Pages (Phase 4)
 *  - pages_read_engagement — necessary alongside pages_show_list
 */
export const META_REQUIRED_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
] as const;
export type MetaScope = (typeof META_REQUIRED_SCOPES)[number];

// ----- form schemas -----

export const TosAcceptSchema = z.object({
  agreed: z.literal(true, {
    errorMap: () => ({ message: 'You must check the box to continue.' }),
  }),
});
export type TosAcceptInput = z.infer<typeof TosAcceptSchema>;

export const RiskAcknowledgmentSchema = z.object({
  scrolled: z.literal(true, {
    errorMap: () => ({
      message: 'Please scroll through the entire risk education before acknowledging.',
    }),
  }),
  ack1: z.literal(true, {
    errorMap: () => ({
      message: 'You must acknowledge that Meta enforcement may suspend your accounts.',
    }),
  }),
  ack2: z.literal(true, {
    errorMap: () => ({
      message: 'You must accept responsibility for your own ad accounts and creative.',
    }),
  }),
});
export type RiskAcknowledgmentInput = z.infer<typeof RiskAcknowledgmentSchema>;

/** Long-lived Meta access token — minimum sanity check before we even
 *  ask Meta to verify it. Real tokens are >100 chars, alnum + a few specials. */
export const MetaTokenInputSchema = z.object({
  accessToken: z
    .string()
    .trim()
    .min(40, 'That looks too short to be a Meta long-lived token.')
    .max(2000, 'That looks too long to be a Meta long-lived token.')
    .regex(/^[A-Za-z0-9_\-|]+$/, 'Token contains unexpected characters.'),
});
export type MetaTokenInput = z.infer<typeof MetaTokenInputSchema>;

export const MetaSelectionSchema = z.object({
  businessManagerId: z.string().min(1, 'Select a Business Manager.'),
  adAccountIds: z
    .array(z.string().min(1))
    .min(1, 'Select at least one ad account.')
    .max(50, 'Pick a smaller initial set; you can add more in settings later.'),
});
export type MetaSelectionInput = z.infer<typeof MetaSelectionSchema>;
