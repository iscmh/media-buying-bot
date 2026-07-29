/**
 * Polish-25.6 Commit 38: Meta rejection-error guidance.
 *
 * Meta's rejection messages are notoriously cryptic — the operator's
 * live-test hit "poţi adăuga o vârstă minimă mai mare" (Romanian for
 * "you can add a higher minimum age"), which is Meta's way of saying
 * the ad account is flagged for a Special Ad Category. Buyers reading
 * that message have no idea what to fix.
 *
 * `interpretMetaError` pattern-matches the raw string against known
 * failure classes and returns a human-readable diagnosis + fix. The
 * /launched page renders a `<MetaRejectionGuidance>` banner below any
 * `rejected_by_meta` or `launch_failed` row's error message so the
 * buyer gets an actionable next step instead of a translated shrug.
 *
 * Categories:
 *   - special_ad_category:  Credit / Employment / Housing / Politics.
 *     Meta restricts age (min 18, max often clamped), location (country
 *     only, no ZIP/city), gender (All), detailed interests (blocked).
 *   - policy_creative:      Ad creative violates a policy (adult, drugs,
 *     misleading claims, etc.). No amount of targeting fixes this;
 *     regenerate the creative.
 *   - policy_landing:       Offer URL / landing page violates policy
 *     (misleading claims, prohibited product, blocked domain).
 *   - budget_currency:      Budget below Meta's account minimum in the
 *     account's currency.
 *   - permissions:          Token is missing a required scope / the
 *     account doesn't have permission for this action.
 *   - other:                No pattern match. Falls back to a generic
 *     "check Meta Ads Manager" hint + surfaces the raw message.
 *
 * Pattern matching is a substring-match over the lowercased message
 * (Meta errors are English by default but can localize to the user's
 * BM language). Add new patterns to the CATEGORY_PATTERNS map as new
 * failure classes surface.
 */

export type MetaErrorCategory =
  | 'special_ad_category'
  | 'policy_creative'
  | 'policy_landing'
  | 'budget_currency'
  | 'permissions'
  | 'other';

export interface MetaErrorGuidance {
  category: MetaErrorCategory;
  /** Short one-line label for the banner header. */
  title: string;
  /** 1-2 sentence plain-English diagnosis of what Meta is saying. */
  diagnosis: string;
  /** Concrete steps the buyer should take before relaunching. */
  fixes: string[];
  /** Optional link to Meta's authoritative documentation. */
  docsUrl?: string;
}

interface Pattern {
  needles: string[];
  guidance: Omit<MetaErrorGuidance, 'category'>;
}

// Order matters — first match wins. Put narrower patterns first.
const CATEGORY_PATTERNS: Record<Exclude<MetaErrorCategory, 'other'>, Pattern[]> = {
  special_ad_category: [
    {
      // English + Romanian variants seen in operator's live test. Add
      // more localized fragments here as they surface — Meta translates
      // rejection messages to the BM's locale.
      needles: [
        'special ad category',
        'special_ad_category',
        'special ad categories',
        'credit, employment',
        'credit / employment',
        'housing, employment',
        'employment, housing',
        'vârstă minimă', // Romanian: "minimum age" — the tell-tale phrase
        'vârstă minimă mai mare',
        'minimum age',
        'age suggestion',
        'age recommendation',
        'higher minimum age',
      ],
      guidance: {
        title: 'Ad account flagged for Special Ad Categories',
        diagnosis:
          'Meta is telling you this ad account is enrolled in a Special Ad Category (Credit, Employment, Housing, or Social Issues/Politics). That flag restricts your targeting — the error message about "minimum age" is Meta\'s cryptic way of saying it, not the literal fix.',
        fixes: [
          'Reduce max age to 55 or lower (Meta enforces this on Special Ad Category accounts).',
          'Use country-level targeting only. Remove any city, ZIP code, or region-level location.',
          'Remove all detailed interest + behavior targeting. Advantage+ audience only.',
          'Set gender to All (Special Ad Categories disallow gender targeting).',
          'If none of your offers fall under Special Ad Categories, contact Meta support to have the account’s flag reviewed.',
        ],
        docsUrl: 'https://www.facebook.com/business/help/298000447747885',
      },
    },
  ],
  policy_creative: [
    {
      needles: [
        'ad creative',
        'creative was rejected',
        'creative rejected',
        'violates our advertising policies',
        'ad policies',
        'unacceptable business',
        'misleading',
        'sensational',
      ],
      guidance: {
        title: 'Creative rejected on Meta policy',
        diagnosis:
          'Meta flagged the ad creative itself (image / video / headline / body copy). No amount of targeting tweaks will unblock this — the creative needs to change.',
        fixes: [
          'Regenerate the variant with softer / less sensational hooks.',
          'Remove specific income claims ("$10k/month"), medical claims, or before/after imagery.',
          'Check the ad in Meta Ads Manager → the rejection detail there is usually more specific than the API response.',
          'If you believe the rejection was in error, request a review from Ads Manager → Account Quality.',
        ],
        docsUrl: 'https://transparency.meta.com/policies/ad-standards/',
      },
    },
  ],
  policy_landing: [
    {
      needles: [
        'landing page',
        'destination',
        'destination url',
        'link is not valid',
        'link violates',
        'blocked domain',
        'domain is not allowed',
      ],
      guidance: {
        title: 'Offer URL / landing page rejected',
        diagnosis:
          "Meta rejected the destination URL, not the ad creative. Common causes: the domain is on Meta's blocklist, the landing page has misleading claims, or Meta's crawler couldn't load it.",
        fixes: [
          'Check the landing page loads correctly with no popups blocking the primary content.',
          'Remove any misleading claims (guaranteed income, medical cures, get-rich-quick).',
          'Try a different domain / redirect chain if the current domain is flagged.',
          'Confirm the domain is verified in Meta Business Suite → Brand Safety → Domains.',
        ],
        docsUrl: 'https://transparency.meta.com/policies/ad-standards/deceptive-content/',
      },
    },
  ],
  budget_currency: [
    {
      needles: [
        'below minimum',
        'daily budget',
        'daily_budget',
        'less than the minimum',
        'currency',
        'minimum bid',
      ],
      guidance: {
        title: 'Budget below Meta minimum',
        diagnosis:
          'Meta requires a minimum daily budget in the ad account’s currency. USD accounts start at $1/day; higher for other currencies (RON ≈ 5, GBP ≈ 1, INR ≈ 40).',
        fixes: [
          'Raise the per-ad daily budget above your account currency’s Meta minimum.',
          'Confirm the ad account currency in Settings → Connections → Meta.',
        ],
      },
    },
  ],
  permissions: [
    {
      needles: [
        'permission',
        'not authorized',
        'missing permission',
        '(#200)',
        'oauth',
        'access token',
        'token has expired',
      ],
      guidance: {
        title: 'Token or permission problem',
        diagnosis:
          'Meta rejected the API call for a permissions reason. Either the access token expired, lost a required scope, or the ad account was removed from the Business Manager the token was minted from.',
        fixes: [
          'Reconnect Meta from Settings → Connections → Meta.',
          'Confirm the token has ads_management + ads_read + business_management scopes.',
          'Confirm the selected ad account is still linked to the Business Manager.',
        ],
      },
    },
  ],
};

const FALLBACK: MetaErrorGuidance = {
  category: 'other',
  title: 'Meta rejected the launch',
  diagnosis:
    'This error doesn’t match any known pattern. Open the ad in Meta Ads Manager → the rejection detail there is usually more specific than the API response we get back.',
  fixes: [
    'Copy the error message + open a Meta Business Support case if the phrasing is opaque.',
    'If the ad account is new, some accounts hit a spend-history threshold before certain features unlock.',
  ],
};

/**
 * Pattern-match an error message against known Meta failure classes.
 * Case-insensitive substring match. Returns FALLBACK when no pattern
 * fires so callers always render SOMETHING actionable.
 */
export function interpretMetaError(errorMessage: string | null | undefined): MetaErrorGuidance {
  if (!errorMessage || errorMessage.trim().length === 0) return FALLBACK;
  const hay = errorMessage.toLowerCase();
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const p of patterns) {
      if (p.needles.some((needle) => hay.includes(needle.toLowerCase()))) {
        return { category: category as MetaErrorCategory, ...p.guidance };
      }
    }
  }
  return FALLBACK;
}
