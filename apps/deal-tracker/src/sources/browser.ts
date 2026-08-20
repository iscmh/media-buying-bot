import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Config } from '../config.js';
import { renderTemplate } from '../matrix.js';
import { parseMoneyAll } from '../extract.js';
import type { Quote, SearchQuery, Source } from '../types.js';

/**
 * Drives the real booking widget in a headless Chromium.
 *
 * Slower and heavier than the API source, but it works before anyone has
 * reverse-engineered the engine's JSON, it survives most markup changes
 * (prices are found by shape, not by a brittle selector chain), and it
 * records the XHR traffic it sees so you can graduate to the API source.
 */

// Minimal structural types — keeps this file honest about the tiny slice of
// Playwright it uses, and keeps `playwright` a lazy import.
interface PwElement {
  innerText(): Promise<string>;
  $(selector: string): Promise<PwElement | null>;
  getAttribute(name: string): Promise<string | null>;
}
interface PwResponse {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
}
interface PwPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  innerText(selector: string): Promise<string>;
  $$(selector: string): Promise<PwElement[]>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  on(event: 'response', handler: (response: PwResponse) => void): void;
  close(): Promise<void>;
}
interface PwBrowser {
  newPage(options?: { locale?: string; userAgent?: string }): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(options: { headless: boolean }): Promise<PwBrowser>;
}

export interface Selectors {
  /** Clicked once per page load if present, e.g. a cookie banner. */
  acceptCookies?: string;
  /** Repeating offer container. Omit to fall back to whole-page price scraping. */
  card?: string;
  /** Room/board name, relative to the card. */
  label?: string;
  /** Price element, relative to the card. */
  price?: string;
  /** Anchor whose href is the booking deep link, relative to the card. */
  link?: string;
  /** Element that must appear before we read prices. */
  ready?: string;
}

const SELECTORS_FILE = './data/selectors.json';
const CAPTURE_FILE = './data/capture-latest.json';

export function loadSelectors(file = SELECTORS_FILE): Selectors {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Selectors;
  } catch {
    return {};
  }
}

/**
 * Picks the stay total out of a card's text. Cards usually show several
 * numbers (per-night rate, strikethrough "was" price, total); the total is
 * the largest plausible one, and a struck-through original is always higher
 * than what you'd actually pay, so we take the largest that is still under
 * the sanity ceiling and prefer a number adjacent to a "total" word.
 */
export function pickCardTotal(
  text: string,
  min: number,
  max: number,
): { value: number; currency?: string } | null {
  const candidates = parseMoneyAll(text).filter((m) => m.value >= min && m.value <= max);
  if (candidates.length === 0) return null;

  const totalLine = text
    .split('\n')
    .find((line) => /total|общо|за престоя|for the stay/i.test(line));
  if (totalLine) {
    const fromTotalLine = parseMoneyAll(totalLine).filter((m) => m.value >= min && m.value <= max);
    if (fromTotalLine[0]) return fromTotalLine[0];
  }

  return candidates.reduce((best, c) => (c.value > best.value ? c : best), candidates[0]!);
}

export class BrowserSource implements Source {
  readonly name = 'browser';
  private browser: PwBrowser | null = null;
  private readonly selectors: Selectors;

  constructor(private readonly cfg: Config) {
    this.selectors = loadSelectors();
  }

  async init(): Promise<void> {
    let chromium: PwChromium;
    try {
      ({ chromium } = (await import('playwright')) as unknown as { chromium: PwChromium });
    } catch {
      throw new Error('playwright is not installed — run "pnpm install" in apps/deal-tracker');
    }
    this.browser = await chromium.launch({ headless: this.cfg.TRACKER_HEADLESS });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  async fetchQuotes(query: SearchQuery): Promise<Quote[]> {
    if (!this.browser) throw new Error('BrowserSource.init() was not called');
    const url = this.cfg.TRACKER_URL_TEMPLATE
      ? renderTemplate(this.cfg.TRACKER_URL_TEMPLATE, query)
      : this.cfg.TRACKER_BOOKING_URL;

    const page = await this.browser.newPage({ locale: 'en-GB' });
    const captured: Array<{ url: string; body: unknown }> = [];

    page.on('response', (response) => {
      const type = response.headers()['content-type'] ?? '';
      if (!type.includes('json') || response.status() >= 400) return;
      // Fire-and-forget: a failed body read must not break the scrape.
      void response
        .text()
        .then((text) => {
          if (text.length < 200_000) {
            captured.push({ url: response.url(), body: JSON.parse(text) as unknown });
          }
        })
        .catch(() => undefined);
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (this.selectors.acceptCookies) {
        await page.click(this.selectors.acceptCookies, { timeout: 4000 }).catch(() => undefined);
      }
      // The engine renders prices client-side after its own XHR round trip.
      await page.waitForTimeout(6000);

      const quotes = await this.extract(page, query);
      if (captured.length > 0) this.writeCapture(captured);
      return quotes;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async extract(page: PwPage, query: SearchQuery): Promise<Quote[]> {
    const min = this.cfg.TRACKER_MIN_PLAUSIBLE_TOTAL;
    const max = this.cfg.TRACKER_MAX_PLAUSIBLE_TOTAL;
    const observedAt = Date.now();
    const quotes: Quote[] = [];

    if (this.selectors.card) {
      for (const card of await page.$$(this.selectors.card)) {
        const text = await card.innerText().catch(() => '');
        if (!text) continue;

        const priceText = this.selectors.price
          ? await (await card.$(this.selectors.price))?.innerText().catch(() => '')
          : undefined;
        const money = pickCardTotal(priceText || text, min, max);
        if (!money) continue;

        const label = this.selectors.label
          ? ((await (await card.$(this.selectors.label))?.innerText().catch(() => '')) ?? '').trim()
          : text.split('\n')[0]?.trim();
        const href = this.selectors.link
          ? await (await card.$(this.selectors.link))?.getAttribute('href').catch(() => null)
          : null;

        quotes.push({
          checkIn: query.checkIn,
          checkOut: query.checkOut,
          nights: query.nights,
          label: label || 'Offer',
          total: money.value,
          currency: money.currency ?? query.currency,
          confidence: this.selectors.price ? 'exact' : 'heuristic',
          ...(href ? { url: new URL(href, this.cfg.TRACKER_BOOKING_URL).toString() } : {}),
          observedAt,
        });
      }
      if (quotes.length > 0) return quotes;
    }

    // No card selector configured (or it matched nothing): fall back to the
    // cheapest plausible number anywhere on the page.
    const body = await page.innerText('body').catch(() => '');
    const all = parseMoneyAll(body).filter((m) => m.value >= min && m.value <= max);
    const cheapest = all.reduce<(typeof all)[number] | undefined>(
      (best, m) => (best === undefined || m.value < best.value ? m : best),
      undefined,
    );
    if (!cheapest) return [];

    return [
      {
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        nights: query.nights,
        label: 'Lowest price on page',
        total: cheapest.value,
        currency: cheapest.currency ?? query.currency,
        confidence: 'heuristic',
        observedAt,
      },
    ];
  }

  private writeCapture(captured: Array<{ url: string; body: unknown }>): void {
    try {
      mkdirSync('./data', { recursive: true });
      writeFileSync(CAPTURE_FILE, JSON.stringify(captured, null, 2), 'utf8');
    } catch {
      // best effort
    }
  }
}
