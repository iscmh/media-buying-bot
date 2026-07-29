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
  | 'safety_layer'
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
// `safety_layer` is dispatched by prefix in interpretMetaError() rather
// than needle-matched here, so it's excluded from this map.
const CATEGORY_PATTERNS: Record<Exclude<MetaErrorCategory, 'other' | 'safety_layer'>, Pattern[]> = {
  special_ad_category: [
    {
      // English + Romanian + Spanish + Portuguese + French + German
      // variants surfaced from operator's live tests. Meta translates
      // rejection messages to the BM's locale — nearly every Special
      // Ad Category error surfaces as "adjust minimum age" or "adjust
      // maximum age" in the operator's language. Add more localized
      // fragments here as they surface.
      //
      // Polish-25.7 Commit 41: bug — first live-fire test had TWO
      // rejected ads, one with "vârstă minimă mai mare" (recognized)
      // and one with "vârstă maximă mai mică" (NOT recognized before
      // this commit). Both are the same Special Ad Category root
      // cause; Meta phrases them differently based on which age
      // boundary it wants adjusted. Full min+max coverage in each
      // supported language now.
      needles: [
        // Category name — English + underscore variants.
        'special ad category',
        'special_ad_category',
        'special ad categories',
        // Explicit category enumerations Meta sometimes returns.
        'credit, employment',
        'credit / employment',
        'housing, employment',
        'employment, housing',
        // English age-boundary phrases.
        'minimum age',
        'maximum age',
        'higher minimum age',
        'lower maximum age',
        'age suggestion',
        'age recommendation',
        'adjust the minimum age',
        'adjust the maximum age',
        // Romanian (RO) — operator's account.
        //   "vârstă" = "age", "minimă" = "minimum", "maximă" = "maximum",
        //   "mai mare" = "higher", "mai mică" = "lower".
        'vârstă',
        'vârstă minimă',
        'vârstă maximă',
        'vârstă minimă mai mare',
        'vârstă maximă mai mică',
        // Spanish (ES).
        'edad mínima',
        'edad máxima',
        'edad minima', // unaccented variant sometimes returned
        'edad maxima',
        // Portuguese (PT / BR).
        'idade mínima',
        'idade máxima',
        'idade minima',
        'idade maxima',
        // French (FR).
        'âge minimum',
        'âge maximum',
        'age minimum',
        'age maximum',
        // German (DE).
        'mindestalter',
        'höchstalter',
        'maximalalter',
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
 * Polish-25.7 Commit 43: pattern-match our own internal safety-layer
 * denials before the generic Meta-side patterns fire. The launcher
 * writes `MetaSafetyDeniedError`'s message straight into
 * `launched_ads.error_message`, so /launched sees strings like
 * `"Meta call denied by safety layer (user_paused): user is paused"`.
 * These are NOT Meta rejections — the call never reached Meta — so
 * rendering them as "Meta rejected the launch" was misleading. Extract
 * the parenthetical code and dispatch to a per-code guidance card.
 *
 * The rate-limiter path (`MetaRateLimitedError`) surfaces as
 * `"Meta call denied by rate limiter; retry after <ISO>"`. Handled in
 * the same branch since it's the same safety-layer family.
 */
const SAFETY_LAYER_PREFIX = 'meta call denied by safety layer';
const RATE_LIMITER_PREFIX = 'meta call denied by rate limiter';

type SafetyGuidance = Omit<MetaErrorGuidance, 'category'>;

function safetyGuidanceForCode(code: string, rawMessage: string): SafetyGuidance {
  switch (code) {
    case 'user_paused':
      return {
        title: 'Your bot is paused',
        diagnosis:
          'The launch never reached Meta — the bot is paused. Every launch attempt while paused fails immediately so nothing spends money without you seeing this first.',
        fixes: [
          'Open the dashboard and read the pause banner to see WHY the bot is paused.',
          'Resolve the underlying issue (reconnect Meta / AI provider / etc.) BEFORE unpausing.',
          'Click Unpause in the banner to resume — new launches will go through immediately.',
        ],
      };
    case 'global_emergency_stop':
      return {
        title: 'Platform is in emergency stop',
        diagnosis:
          "Platform-wide safety pause is active. Every user's launches are blocked, not just yours. This is triggered when a global spend anomaly or an outage is detected.",
        fixes: [
          'Wait for the emergency stop to clear (usually minutes, not hours).',
          'If this persists beyond an hour, contact support with the timestamp of this error.',
        ],
      };
    case 'token_expired':
    case 'token_missing':
      return {
        title: 'Meta token expired or missing',
        diagnosis:
          "The stored Meta access token is expired or was never set. Meta's launcher can't call the Graph API without a valid token.",
        fixes: [
          'Reconnect Meta from Settings → Connections → Meta.',
          'Confirm the reconnect surfaces the ad account you want to launch on.',
        ],
      };
    case 'rate_limited':
      return {
        title: 'Meta rate limit hit — cooling down',
        diagnosis:
          'Meta throttled our recent calls on this ad account. The safety layer stops sending until the cooldown clears — this prevents Meta from escalating to an account-level block.',
        fixes: [
          'Wait for the cooldown to lift (usually 5–15 minutes).',
          'Reduce launch batch size if you routinely hit this — split large batches across sessions.',
        ],
      };
    case 'user_ceiling_exceeded':
      return {
        title: 'Personal spend cap reached',
        diagnosis:
          'Your configured per-day / per-week spend cap has been reached across all launched ads. The safety layer blocks new launches until the window rolls over or you raise the cap.',
        fixes: [
          'Adjust your spend cap in Settings → General → Spend caps.',
          'Wait for the daily / weekly window to reset if you want the cap to keep enforcing.',
        ],
      };
    case 'platform_ceiling_exceeded':
      return {
        title: 'Platform hard cap reached',
        diagnosis:
          "The platform-wide hard spend ceiling has been reached — this is above your personal cap and is set by the operators. Every user's launches are affected once this fires.",
        fixes: [
          'This is a global safety floor. Contact support if it persists beyond a rollover window.',
        ],
      };
    case 'suspicious_activity_pause':
      return {
        title: 'Bot auto-paused for review',
        diagnosis:
          'The safety layer detected a spend / performance pattern outside your normal baseline and paused the bot to prevent runaway spend. This is a precaution, not an accusation.',
        fixes: [
          'Open the dashboard — the pause banner explains the trigger.',
          'Confirm recent launches look right, then Unpause to resume.',
        ],
      };
    default:
      // Unknown code — surface the raw message so the operator has SOMETHING to
      // grep for even when a new safety code ships without a card here.
      return {
        title: 'Safety layer denied the launch',
        diagnosis: `The safety layer blocked this launch (code: ${code}). The call never reached Meta.`,
        fixes: [`Raw error: ${rawMessage}`, 'Contact support with the code above if this recurs.'],
      };
  }
}

/**
 * Pattern-match an error message against known failure classes.
 * Case-insensitive substring match. Returns FALLBACK when no pattern
 * fires so callers always render SOMETHING actionable.
 *
 * Order:
 *   1. Our own safety-layer / rate-limiter prefixes (call never reached
 *      Meta). These MUST run first — otherwise a stray substring in the
 *      wrapped reason could match a Meta-side pattern like "special ad
 *      category" and misclassify the diagnosis.
 *   2. The Meta-side CATEGORY_PATTERNS map (needle substring match).
 *   3. FALLBACK.
 */
export function interpretMetaError(errorMessage: string | null | undefined): MetaErrorGuidance {
  if (!errorMessage || errorMessage.trim().length === 0) return FALLBACK;
  const hay = errorMessage.toLowerCase();

  if (hay.startsWith(SAFETY_LAYER_PREFIX)) {
    const match = errorMessage.match(/safety layer \(([a-z0-9_]+)\)/i);
    const code = match?.[1] ?? 'unknown';
    return { category: 'safety_layer', ...safetyGuidanceForCode(code, errorMessage) };
  }
  if (hay.startsWith(RATE_LIMITER_PREFIX)) {
    return { category: 'safety_layer', ...safetyGuidanceForCode('rate_limited', errorMessage) };
  }

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const p of patterns) {
      if (p.needles.some((needle) => hay.includes(needle.toLowerCase()))) {
        return { category: category as MetaErrorCategory, ...p.guidance };
      }
    }
  }
  return FALLBACK;
}
