import { z } from 'zod';

/**
 * Polish-25.2 Commit 15: Meta launch input schemas.
 *
 * OfferUrlSchema pins the shape of the "click destination" URL passed
 * into the launcher. Before Commit 15 this field flowed through
 * launchApprovedAction untouched — Meta itself was the first line
 * of validation. Real evidence from launched_ads row 7632f517
 * (Romanian-locale operator): a URL "https//aima-systems.com"
 * (missing colon after https) bypassed the launch dialog, hit Meta,
 * came back rejected with a localized error. User had to check SQL
 * to see what happened.
 *
 * Both the client (Launch confirm dialog) + server
 * (launchApprovedAction) share this schema so a malformed URL is
 * caught before we spend a Meta API call on it.
 *
 * Requirements:
 *   - Must parse as a URL (Zod's built-in z.string().url() uses the
 *     WHATWG URL parser under the hood; "https//foo.com" fails
 *     because it has no colon-slash-slash sequence).
 *   - Protocol restricted to http: or https: (block ftp:, mailto:,
 *     javascript:, etc. — Meta only takes http/https anyway, but the
 *     stricter local check gives a cleaner error).
 *   - Max 500 chars (matches concept.offer_url column max).
 */
export const OFFER_URL_MAX_CHARS = 500;

// The WHATWG URL parser is permissive — `new URL('https:foo.com')`
// and `new URL('https:/foo.com')` both succeed, giving `pathname`
// `'foo.com'` and a null host. Meta rejects these (correctly). We
// require the literal `http(s)://` prefix so anything shorter falls
// out before we reach Zod's URL check.
const OFFER_URL_PREFIX_REGEX = /^https?:\/\//i;

export const OfferUrlSchema = z
  .string()
  .trim()
  .min(1, 'Offer URL is required.')
  .max(OFFER_URL_MAX_CHARS, `Offer URL must be ${OFFER_URL_MAX_CHARS} characters or fewer.`)
  .refine((v) => OFFER_URL_PREFIX_REGEX.test(v), {
    message: 'Enter a full URL starting with http:// or https://.',
  })
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        // Belt-and-suspenders: protocol MUST be http/https AND host
        // must be non-empty. WHATWG accepts protocol-only shapes
        // (`https://`) with empty host — reject those too.
        return (
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0
        );
      } catch {
        return false;
      }
    },
    { message: 'Offer URL is not a valid web address.' },
  );

/**
 * Convenience: predicate form for use inside disable-button logic
 * where returning a boolean is cleaner than surfacing a Zod error.
 */
export function isValidOfferUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return OfferUrlSchema.safeParse(value).success;
}
