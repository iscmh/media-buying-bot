import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.js';
import { renderTemplate } from '../matrix.js';
import { coerceNumber, findPriceCandidates, queryPath, type Json } from '../extract.js';
import type { Quote, SearchQuery, Source } from '../types.js';

/**
 * Replays the booking engine's own availability request.
 *
 * The engine at reservations.hvdhotels.com is a JS app that fetches prices
 * over JSON — far cheaper to poll than driving a browser. Since its exact
 * contract isn't public, `pnpm discover` records a real search and writes
 * the template this source replays. See README "Wiring up the real site".
 */

export interface EndpointConfig {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** JSON body (object) or raw string; placeholders are substituted in both. */
  body?: Json;
  /** Path to the array of offers, e.g. `data.offers[*]` or `results[*].rates[*]`. */
  offersPath?: string;
  /** Paths *relative to each offer* when offersPath is set. */
  pricePath?: string;
  labelPath?: string;
  currencyPath?: string;
  urlPath?: string;
}

export function loadEndpointConfig(file: string): EndpointConfig | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as EndpointConfig;
  } catch {
    return null;
  }
}

const NUMERIC_PLACEHOLDER = /^\{\{?(adults|children|nights)\}?\}$/;

/** Substitutes {checkIn}-style placeholders through a whole JSON tree. */
export function renderJson(node: Json, query: SearchQuery): Json {
  if (typeof node === 'string') {
    // Keep counts numeric — some engines reject "3" where they want 3 — but
    // only for placeholders that are always numbers. Dates and age lists
    // stay strings.
    if (NUMERIC_PLACEHOLDER.test(node.trim())) {
      const value = Number(renderTemplate(node.trim(), query));
      if (Number.isFinite(value)) return value;
    }
    return renderTemplate(node, query);
  }
  if (Array.isArray(node)) return node.map((child) => renderJson(child, query));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, renderJson(value, query)]),
    );
  }
  return node;
}

function firstString(payload: Json, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const value = queryPath(payload, path)[0];
  return typeof value === 'string' ? value : undefined;
}

export function quotesFromPayload(
  cfg: Config,
  endpoint: EndpointConfig,
  payload: Json,
  query: SearchQuery,
  observedAt = Date.now(),
): Quote[] {
  const inRange = (n: number): boolean =>
    n >= cfg.TRACKER_MIN_PLAUSIBLE_TOTAL && n <= cfg.TRACKER_MAX_PLAUSIBLE_TOTAL;

  // Exact mode: you pinned the paths, we read exactly those.
  if (endpoint.offersPath && endpoint.pricePath) {
    const quotes: Quote[] = [];
    for (const offer of queryPath(payload, endpoint.offersPath)) {
      const priceNode = queryPath(offer, endpoint.pricePath)[0];
      const total = priceNode === undefined ? null : coerceNumber(priceNode);
      if (total === null || !inRange(total)) continue;

      const url = firstString(offer, endpoint.urlPath);
      quotes.push({
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        nights: query.nights,
        label: firstString(offer, endpoint.labelPath) ?? 'Offer',
        total,
        currency: firstString(offer, endpoint.currencyPath) ?? query.currency,
        confidence: 'exact',
        ...(url ? { url } : {}),
        observedAt,
      });
    }
    return quotes;
  }

  // Heuristic mode: no paths pinned yet — report the cheapest price-shaped
  // number in the payload and flag it so alerts say "verify before booking".
  const candidates = findPriceCandidates(payload).filter((c) => inRange(c.value));
  const cheapest = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, c) => (best === undefined || c.value < best.value ? c : best),
    undefined,
  );
  if (!cheapest) return [];

  return [
    {
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      nights: query.nights,
      label: `Lowest listed price (${cheapest.path})`,
      total: cheapest.value,
      currency: cheapest.currency ?? query.currency,
      confidence: 'heuristic',
      observedAt,
    },
  ];
}

export class ApiSource implements Source {
  readonly name = 'api';
  private endpoint: EndpointConfig | null = null;

  constructor(private readonly cfg: Config) {}

  async init(): Promise<void> {
    this.endpoint = loadEndpointConfig(this.cfg.TRACKER_ENDPOINT_FILE);
    if (!this.endpoint) {
      throw new Error(
        `No endpoint template at ${this.cfg.TRACKER_ENDPOINT_FILE}. ` +
          `Run "pnpm discover" first (see README), or set TRACKER_SOURCE=browser.`,
      );
    }
  }

  async fetchQuotes(query: SearchQuery): Promise<Quote[]> {
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error('ApiSource.init() was not called');

    const url = renderTemplate(endpoint.url, query);
    const method = endpoint.method ?? (endpoint.body === undefined ? 'GET' : 'POST');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const body =
        endpoint.body === undefined
          ? undefined
          : typeof endpoint.body === 'string'
            ? renderTemplate(endpoint.body, query)
            : JSON.stringify(renderJson(endpoint.body, query));

      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...endpoint.headers,
        },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} from booking API: ${text.slice(0, 200)}`);

      let payload: Json;
      try {
        payload = JSON.parse(text) as Json;
      } catch {
        this.dumpFailure(query, text);
        throw new Error('Booking API returned non-JSON — dumped to data/last-failure.txt');
      }

      return quotesFromPayload(this.cfg, endpoint, payload, query);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Keeps the last bad response around so a broken template is debuggable. */
  private dumpFailure(query: SearchQuery, text: string): void {
    try {
      const file = './data/last-failure.txt';
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${query.checkIn} ${query.nights}n\n\n${text.slice(0, 20_000)}`, 'utf8');
    } catch {
      // best effort
    }
  }
}
