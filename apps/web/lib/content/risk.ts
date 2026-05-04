/**
 * Risk education content. Rendered at /onboarding/risk. Operator-language,
 * not legalese. The whole point is that the user has a realistic mental
 * model of what they're walking into BEFORE they connect a token.
 *
 * Sections are surfaced by the page in order; the page tracks scroll-to-
 * bottom via IntersectionObserver and gates the acknowledgment area
 * behind it.
 */

export interface RiskSection {
  heading: string;
  body: string[];
}

export const RISK_SECTIONS: RiskSection[] = [
  {
    heading: 'Why this matters',
    body: [
      "Meta has gotten meaningfully more aggressive on UBP enforcement in 2024-2025. The pattern: a single ad with a borderline claim gets flagged, the ad account gets a strike, the strike escalates to the Business Manager, the BM gets a 'review' that lasts 14-30 days, and during that review the BM cannot run any ads. If the review goes badly, the BM is permanently restricted. If the BM is tied to your personal Facebook account, your personal account often gets pulled into the same review.",
      'Operators in MMO, biz-opp, finance, crypto, supplements, weight-loss, and crypto-adjacent verticals have been getting hit hardest. The exact triggers are not public and not consistent — what passed last week may get flagged this week, often by an automated reviewer.',
    ],
  },
  {
    heading: 'What can happen, in approximate order of severity',
    body: [
      '1. Single ad rejected. Easy: edit and relaunch.',
      '2. Ad account flagged. Manageable. Slow down, audit your creative for banned phrases, wait it out.',
      "3. Ad account disabled. You can sometimes appeal. Often you can't. Move spend to another ad account in the same BM if you have one.",
      "4. Business Manager restricted. This is the bad one. All ad accounts under the BM stop running. Pixel is paused. Cannot create new ad accounts. The 'review' takes 14-30 days and frequently comes back with a permanent restriction.",
      "5. Personal Facebook account holds. If the BM is tied to your personal account (which it usually is for solo operators), your personal account may lose ability to advertise across all BMs you're a part of. Family pictures still work. Ads do not.",
      "6. Payment method bans. Meta bans the credit card across all accounts. You'll need a different card and sometimes a different name on file.",
      '7. Pixel review. Pixel events stop firing or get marked as suspicious until the review clears.',
    ],
  },
  {
    heading: 'What the platform does to reduce risk',
    body: [
      "Sequential API calls per user. We never parallelize requests against your Meta account — that's one of the strongest pattern signals Meta uses to flag automation.",
      "60% rate limit ceiling. Meta gives Standard Access apps 200 calls per hour. We cap our own usage at 120/hour per user, which leaves headroom for whatever else you're doing manually.",
      'Pattern-of-use staggering (Phase 4). Ad sets created 30-60 seconds apart, never simultaneously. No more than 30 ad creations per hour. No more than 50% of ad sets killed in any single hour.',
      'Pre-launch compliance checks (Phase 4). Your creative is scanned for known-bad phrases and missing landing-page compliance markers (privacy policy link, terms link, contact info) before any launch.',
      "Suspicious-activity auto-pause. If your ad rejection rate exceeds 30% in 24 hours, or three ads get rejected for the same policy reason in a row, we auto-pause the bot and notify you over Telegram. You'd rather see one bad ad than ten.",
      "Per-user and global kill switches. You can pause your bot from the dashboard at any time. We can pause your bot remotely if we detect something dangerous. There's a global emergency stop that halts every customer at once if Meta breaks something on their side.",
      'Audit log on every Meta API call. Endpoint, sanitized request body, response status, latency, and timestamp. Required for liability defense if you ever need to dispute a bot action.',
    ],
  },
  {
    heading: 'What the platform cannot prevent',
    body: [
      "Meta policy changes mid-month. We can keep up with the documented policy. We cannot keep up with internal policy interpretations that aren't published.",
      "Competitors flagging your ads. There is a 'report ad' button on every ad. If a competitor mass-reports, the volume itself is a signal.",
      'Manual reviewer judgment. A human reviewer can disable an ad account for reasons that are not transparent and not appealable. We have no influence here.',
      "Vertical-specific crackdowns. When Meta decides to hammer 'crypto trading bots' or 'AI nudify apps' for a quarter, every operator in the adjacent space gets caught up.",
      'End-customer complaints. Refunds, chargebacks, and BBB-style complaints about your offer get reported back to Meta and contribute to ad account quality scores.',
    ],
  },
  {
    heading: 'Our honest recommendation',
    body: [
      "Use a fresh agency Business Manager with no link to your personal Facebook account, especially for MMO/biz-opp/finance. The cost is a few hundred dollars a month. The benefit is that when something gets banned — and at scale, something will get banned — the blast radius stops at the agency BM and doesn't reach your personal life.",
      "Never run aggressive verticals on a BM tied to your real name and real Facebook account. The math on 'I'll save the agency BM fee and use my own BM' has burned a lot of operators. If you must use your own BM for compliance reasons (regulated finance, etc.), accept that some level of personal exposure is the cost of doing business.",
      'Treat Meta as a hostile platform, not a partner. They will not warn you before changes. They will not help you appeal. They will not tell you what specifically went wrong. Build your operation assuming the worst case is a 30-day BM restriction with no recourse, because sometimes it is.',
    ],
  },
];

/** Acknowledgment text. Wording matters — don't soften it. */
export const RISK_ACKNOWLEDGMENT_LABELS = {
  ack1: 'I understand Meta enforcement is aggressive in my vertical and my accounts may be suspended at any time.',
  ack2: 'I take full responsibility for my own ad accounts, ad creative, and Meta policy compliance. The platform provides automation tools, not legal or policy guarantees.',
} as const;
