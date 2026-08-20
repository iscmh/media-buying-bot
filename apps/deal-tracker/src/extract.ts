/**
 * Price extraction helpers.
 *
 * The booking engine's exact JSON shape is unknown until `pnpm discover`
 * records it, so everything here works two ways:
 *   - exact:     you pin a path (offers[*].price.total) and we read it
 *   - heuristic: we deep-walk the payload for price-shaped fields
 * Heuristic quotes are flagged as such and never treated as gospel.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const PRICE_KEY = /(price|total|amount|rate|cost|gross|net|sum)/i;
const PER_NIGHT_KEY = /(per_?night|nightly|avg|average|daily)/i;
const EXCLUDE_KEY = /(id|code|count|qty|quantity|index|version|age|percent|discount_?pct)/i;
const CURRENCY_KEY = /^(currency|currency_?code|cur|iso_?currency)$/i;

/**
 * Money as it appears in the wild: an optional symbol either side, digits
 * grouped with any of the separators Europe uses. Built fresh per call —
 * a shared /g/ regex carries `lastIndex` between callers and deadlocks
 * anything that nests one call inside another's loop.
 */
const CURRENCY_TOKEN = String.raw`€|£|\$|лв\.?|BGN|EUR|USD|GBP|RON`;
const MONEY_SOURCE =
  String.raw`(?:(${CURRENCY_TOKEN})\s*)?` +
  // Grouped form ("1 234,56") needs at least one separator group, so it
  // cannot swallow the leading digits of a plain number like 2450.
  String.raw`(\d{1,3}(?:[ .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)` +
  String.raw`\s*(${CURRENCY_TOKEN})?`;

function moneyRegex(global: boolean): RegExp {
  return new RegExp(MONEY_SOURCE, global ? 'gi' : 'i');
}

const SYMBOL_TO_CODE: Record<string, string> = {
  '€': 'EUR',
  $: 'USD',
  '£': 'GBP',
  лв: 'BGN',
  'лв.': 'BGN',
};

/**
 * Parses "1 234,56 €", "€1,234.56", "1234.56 BGN" into a number.
 *
 * The thousands/decimal separator is inferred: whichever of `.` or `,`
 * appears last is the decimal point, unless the trailing group is exactly
 * 3 digits and there is only one separator (then it is a thousands mark).
 */
export function parseMoney(text: string): { value: number; currency?: string } | null {
  const match = moneyRegex(false).exec(text);
  return match ? fromMatch(match) : null;
}

function fromMatch(match: RegExpExecArray): { value: number; currency?: string } | null {
  const [, prefix, digits, suffix] = match;
  if (digits === undefined) return null;

  const symbol = (prefix ?? suffix ?? '').trim();
  const currency = symbol
    ? (SYMBOL_TO_CODE[symbol] ?? symbol.toUpperCase().replace('.', ''))
    : undefined;

  const value = parseNumericGroup(digits);
  if (value === null) return null;
  return currency ? { value, currency } : { value };
}

function parseNumericGroup(digits: string): number | null {
  const cleaned = digits.replace(/\s/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalised: string;

  if (lastComma === -1 && lastDot === -1) {
    normalised = cleaned;
  } else {
    const sepIndex = Math.max(lastComma, lastDot);
    const decimals = cleaned.length - sepIndex - 1;
    const separators = (cleaned.match(/[.,]/g) ?? []).length;
    if (decimals === 3 && separators === 1) {
      // "1.234" / "1,234" — a thousands separator, not a decimal point.
      normalised = cleaned.replace(/[.,]/g, '');
    } else {
      normalised =
        cleaned.slice(0, sepIndex).replace(/[.,]/g, '') + '.' + cleaned.slice(sepIndex + 1);
    }
  }

  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/** Every money-looking token in a blob of rendered page text. */
export function parseMoneyAll(text: string): Array<{ value: number; currency?: string }> {
  const out: Array<{ value: number; currency?: string }> = [];
  const regex = moneyRegex(true);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const parsed = fromMatch(match);
    if (parsed) out.push(parsed);
    if (match.index === regex.lastIndex) regex.lastIndex++; // belt and braces
  }
  return out;
}

export interface PriceCandidate {
  /** Dotted path into the payload, e.g. `offers[2].price.total`. */
  path: string;
  value: number;
  currency?: string;
  /** Rough "this looks like a real total" score, higher is better. */
  score: number;
}

/**
 * Deep-walks a JSON payload collecting values that look like prices, so
 * `discover` can show you where the numbers live and the API source can
 * fall back to a best guess before you pin an exact path.
 */
export function findPriceCandidates(payload: Json, maxDepth = 8): PriceCandidate[] {
  const out: PriceCandidate[] = [];

  const walk = (node: Json, path: string, depth: number, nearbyCurrency?: string): void => {
    if (depth > maxDepth || node === null) return;

    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`, depth + 1, nearbyCurrency));
      return;
    }

    if (typeof node === 'object') {
      let currency = nearbyCurrency;
      for (const [key, value] of Object.entries(node)) {
        if (CURRENCY_KEY.test(key) && typeof value === 'string' && value.length <= 4) {
          currency = value.toUpperCase();
        }
      }
      for (const [key, value] of Object.entries(node)) {
        walk(value, path ? `${path}.${key}` : key, depth + 1, currency);
      }
      return;
    }

    const leafKey = path.split(/[.[]/).pop()?.replace(/\]$/, '') ?? path;
    if (!PRICE_KEY.test(leafKey) || EXCLUDE_KEY.test(leafKey)) return;

    let value: number | null = null;
    let currency = nearbyCurrency;
    if (typeof node === 'number') {
      value = node;
    } else if (typeof node === 'string') {
      const parsed = parseMoney(node);
      if (parsed) {
        value = parsed.value;
        currency = parsed.currency ?? currency;
      }
    }
    if (value === null || !Number.isFinite(value) || value <= 0) return;

    let score = 10;
    if (/total/i.test(leafKey)) score += 6;
    if (/gross/i.test(leafKey)) score += 3;
    if (PER_NIGHT_KEY.test(path)) score -= 8;
    if (/tax|fee|deposit|discount|saving/i.test(path)) score -= 6;
    if (currency) score += 2;

    out.push(currency ? { path, value, currency, score } : { path, value, score });
  };

  walk(payload, '', 0, undefined);
  return out.sort((a, b) => b.score - a.score || a.value - b.value);
}

/**
 * Reads a dotted path out of a payload. `[*]` fans out over an array, so
 * `offers[*].price.total` returns one entry per offer.
 */
export function queryPath(payload: Json, path: string): Json[] {
  const segments = path
    .replace(/\[(\d+|\*)\]/g, '.[$1]')
    .split('.')
    .filter((s) => s.length > 0);

  let current: Json[] = [payload];
  for (const segment of segments) {
    const next: Json[] = [];
    for (const node of current) {
      if (node === null || typeof node !== 'object') continue;
      if (segment === '[*]') {
        if (Array.isArray(node)) next.push(...node);
        continue;
      }
      const indexMatch = /^\[(\d+)\]$/.exec(segment);
      if (indexMatch?.[1] !== undefined) {
        if (!Array.isArray(node)) continue;
        const item = node[Number(indexMatch[1])];
        if (item !== undefined) next.push(item);
        continue;
      }
      if (Array.isArray(node)) continue;
      const value = node[segment];
      if (value !== undefined) next.push(value);
    }
    current = next;
  }
  return current;
}

/** Coerces whatever a path returned into a number, tolerating "1 234,00 €". */
export function coerceNumber(value: Json): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return parseMoney(value)?.value ?? null;
  return null;
}
