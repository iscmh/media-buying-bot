/**
 * ToS content. Single source rendered at /legal/tos (public, read-only)
 * AND /onboarding/tos (gated, with checkbox). Bump TOS_VERSION in
 * @mbb/shared when this changes.
 *
 * Tone: operator-honest, plain English where possible. Real legal review
 * happens before paid tiers (Phase 8). Until then we surface the
 * "platform v1, counsel review pending" disclosure on both pages.
 */

export interface TosSection {
  heading: string;
  body: string[];
}

export const TOS_SECTIONS: TosSection[] = [
  {
    heading: 'What this platform does',
    body: [
      'Media Buying Bot automates Meta ad creative generation, launch, kill, and scale on behalf of customers running paid acquisition campaigns. You provide your own Meta Business Manager and your own AI UGC provider. We orchestrate the API calls and apply your kill/scale rules.',
    ],
  },
  {
    heading: 'You bring your own Meta credentials',
    body: [
      "We don't ask for your Facebook password and we don't take ownership of your Meta accounts. You create your own Meta Developer App, generate your own long-lived access token, and paste it here. We store the token encrypted and use it to make API calls on your behalf. You can revoke it at any time from the Meta Developer Console; doing so disconnects you from the platform immediately.",
    ],
  },
  {
    heading: 'Meta enforcement risk is real and the risk is yours',
    body: [
      'Meta aggressively enforces its Unacceptable Business Practices (UBP) policy in MMO, biz-opp, finance, crypto, supplements, and other "high-risk" verticals. Enforcement is not consistent, not transparent, and not appealable in any meaningful way for most operators. Cascading suspensions are real: a flagged ad on one ad account can lead to BM-level restrictions, payment method bans, and personal Facebook account holds.',
      "We build the platform with anti-ban guardrails (sequential API calls, conservative rate limits, suspicious-activity auto-pause, dry-run mode, pre-launch compliance checks). These reduce risk. They do not eliminate it. If you run aggressive verticals on a personal-tied Business Manager, your personal Facebook account is on the line — that is true with or without our platform, but it's especially worth saying out loud here.",
      'Our recommendation, particularly for MMO/biz-opp/finance: use a fresh agency Business Manager with separation from your personal accounts. We are not currently affiliated with any agency BM provider; we expect to add a referral integration in a future phase and will disclose any compensation we receive from those referrals.',
    ],
  },
  {
    heading: 'Indemnification',
    body: [
      "You indemnify and hold harmless Media Buying Bot, its operators, and its successors against any claims, damages, fines, or losses arising from: (a) the content of your ads, (b) your use of Meta's platforms in violation of Meta's policies, (c) the suspension, restriction, or banning of your Meta accounts, (d) regulatory action (FTC, state AGs, foreign equivalents) related to your offers, (e) chargebacks, refunds, or disputes from end-customers of your ads, (f) any third-party intellectual property claims relating to creative you upload or generate.",
    ],
  },
  {
    heading: 'Limitation of liability',
    body: [
      'Our total liability to you, in any 12-month window, is capped at the greater of (a) the fees you have paid the platform in the 30 days preceding the claim, or (b) one hundred US dollars ($100). The MVP is free, so during the MVP this means $100. We do not warrant that the platform, the Meta API, or any third-party AI UGC provider will be available, error-free, or compliant with any specific Meta policy at any given time.',
    ],
  },
  {
    heading: 'No warranty on Meta API or AI provider availability',
    body: [
      "Meta changes its Marketing API on a quarterly basis and occasionally without notice. AI UGC providers (Arcads, HeyGen, Creatify) change pricing, models, and rate limits at their own discretion. The platform may experience reduced functionality, broken features, or temporary outages as a result. We will work to keep things working but we cannot guarantee any specific provider's behavior at any specific time.",
    ],
  },
  {
    heading: 'Our right to suspend your account',
    body: [
      "We may suspend your access to the platform — temporarily or permanently — if your usage causes Meta API rate limit violations, appears to violate Meta's policies in ways that put other customers at risk, or otherwise indicates the platform is being used for purposes other than legitimate paid acquisition automation. We will notify you over Telegram and email if we do this and explain why.",
    ],
  },
  {
    heading: 'Disclosure: future referral compensation',
    body: [
      'We may, in a future phase, integrate with agency Business Manager providers and receive referral compensation when customers we refer sign up with them. When that integration ships, we will disclose the relationship clearly on the relevant onboarding step (per FTC guidance on affiliate relationships). No such relationships exist as of this version.',
    ],
  },
  {
    heading: 'Changes to these terms',
    body: [
      'These terms are platform v1. They will be reviewed by counsel before paid tiers launch. We will bump the version date at the top when meaningful changes are made and require re-acceptance from existing users — you will see this re-acceptance flow on your next login after a bump. If you find a problem with these terms or have a question, message the platform operator on Telegram.',
    ],
  },
];

export const TOS_DISCLOSURE_BANNER =
  'These terms are platform v1 — they’ll be reviewed by counsel before paid tiers launch. Found a problem? Message the platform operator on Telegram.';
