/**
 * One-off recorder that turns "I clicked search on the hotel's site" into a
 * replayable endpoint template for the fast API source.
 *
 *   pnpm discover                 # opens a real browser, records what it sees
 *   pnpm discover -- --headless   # for a server with no display
 *
 * Do the search by hand in the window that opens (your dates, 3 adults,
 * 1 child aged 12), wait for prices to render, then come back and press
 * Enter. Everything the page fetched is written to data/discovery-*.json and
 * the most price-shaped request is turned into data/endpoint.suggested.json.
 */

import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { findPriceCandidates, type Json } from './extract.js';
import type { EndpointConfig } from './sources/api.js';

interface Capture {
  url: string;
  method: string;
  requestBody?: string;
  requestHeaders: Record<string, string>;
  status: number;
  body: Json;
}

interface PwResponse {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
  request(): { method(): string; postData(): string | null; headers(): Record<string, string> };
}
interface PwPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  on(event: 'response', handler: (response: PwResponse) => void): void;
}
interface PwBrowser {
  newPage(options?: { locale?: string }): Promise<PwPage>;
  close(): Promise<void>;
}

/** Request headers worth replaying; auth/session bits included, noise dropped. */
const KEEP_HEADERS =
  /^(authorization|x-|accept|accept-language|content-type|cookie|origin|referer)/i;

function pickHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => KEEP_HEADERS.test(key) && key.toLowerCase() !== 'content-length',
    ),
  );
}

/**
 * `offers[3].price.total` → { offersPath: 'offers[*]', pricePath: 'price.total' }
 * so the API source can iterate every offer instead of the one we happened
 * to see first.
 */
export function splitOfferPath(path: string): { offersPath?: string; pricePath: string } {
  const lastIndex = path.lastIndexOf('[');
  if (lastIndex === -1) return { pricePath: path };
  const close = path.indexOf(']', lastIndex);
  if (close === -1) return { pricePath: path };

  const offersPath = `${path.slice(0, lastIndex)}[*]`;
  const pricePath = path.slice(close + 1).replace(/^\./, '');
  return pricePath ? { offersPath, pricePath } : { pricePath: path };
}

/** Finds a string field that reads like a room/offer name inside an offer object. */
export function guessLabelPath(offer: Json, depth = 0, prefix = ''): string | undefined {
  if (depth > 3 || offer === null || typeof offer !== 'object' || Array.isArray(offer)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(offer)) {
    if (typeof value === 'string' && value.length > 2 && value.length < 120) {
      if (/(name|title|room|category|board|description|caption)/i.test(key)) {
        return prefix ? `${prefix}.${key}` : key;
      }
    }
  }
  for (const [key, value] of Object.entries(offer)) {
    const nested = guessLabelPath(value, depth + 1, prefix ? `${prefix}.${key}` : key);
    if (nested) return nested;
  }
  return undefined;
}

export function scoreCapture(capture: Capture): number {
  const candidates = findPriceCandidates(capture.body);
  if (candidates.length === 0) return 0;
  const best = candidates[0];
  return (best?.score ?? 0) + Math.min(candidates.length, 20);
}

export function suggestEndpoint(capture: Capture): EndpointConfig | null {
  const candidates = findPriceCandidates(capture.body);
  const best = candidates[0];
  if (!best) return null;

  const { offersPath, pricePath } = splitOfferPath(best.path);
  const endpoint: EndpointConfig = {
    url: capture.url,
    method: capture.method === 'POST' ? 'POST' : 'GET',
    headers: capture.requestHeaders,
    ...(capture.requestBody ? { body: safeJson(capture.requestBody) } : {}),
    ...(offersPath ? { offersPath } : {}),
    pricePath,
  };

  if (offersPath) {
    const label = guessLabelPath(firstOffer(capture.body, offersPath));
    if (label) endpoint.labelPath = label;
  }
  return endpoint;
}

function firstOffer(payload: Json, offersPath: string): Json {
  const segments = offersPath.replace('[*]', '').split('.');
  let node: Json = payload;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
    node = node[segment] ?? null;
  }
  return Array.isArray(node) ? (node[0] ?? null) : null;
}

function safeJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const headless = process.argv.includes('--headless');

  let chromium: { launch(options: { headless: boolean }): Promise<PwBrowser> };
  try {
    ({ chromium } = (await import('playwright')) as unknown as {
      chromium: { launch(options: { headless: boolean }): Promise<PwBrowser> };
    });
  } catch {
    console.error('playwright is not installed — run "pnpm install" in apps/deal-tracker first.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ locale: 'en-GB' });
  const captures: Capture[] = [];

  page.on('response', (response) => {
    const type = response.headers()['content-type'] ?? '';
    if (!type.includes('json')) return;
    void response
      .text()
      .then((text) => {
        if (text.length > 400_000) return;
        const request = response.request();
        const postData = request.postData();
        captures.push({
          url: response.url(),
          method: request.method(),
          ...(postData ? { requestBody: postData } : {}),
          requestHeaders: pickHeaders(request.headers()),
          status: response.status(),
          body: safeJson(text),
        });
      })
      .catch(() => undefined);
  });

  console.info(`Opening ${cfg.TRACKER_BOOKING_URL} …`);
  await page.goto(cfg.TRACKER_BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.info('');
  console.info('👉 In the browser window, run the search you care about:');
  console.info(
    `   ${cfg.occupancy.adults} adults + ${cfg.occupancy.childAges.length} child (age ${cfg.occupancy.childAges.join(', ')}), a date next season.`,
  );
  console.info('   Wait until the prices are on screen, then come back here.');
  console.info('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter once prices are visible… ');
  rl.close();

  await browser.close();

  mkdirSync('./data', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = `./data/discovery-${stamp}.json`;
  writeFileSync(dumpFile, JSON.stringify(captures, null, 2), 'utf8');

  const ranked = captures
    .map((capture) => ({ capture, score: scoreCapture(capture) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  console.info('');
  console.info(`Recorded ${captures.length} JSON responses → ${dumpFile}`);
  if (ranked.length === 0) {
    console.info('None of them looked like prices. Did the search actually return rooms?');
    console.info('If the engine renders prices server-side, use TRACKER_SOURCE=browser instead.');
    return;
  }

  console.info('');
  console.info('Most price-shaped responses:');
  ranked.slice(0, 5).forEach((entry, i) => {
    const top = findPriceCandidates(entry.capture.body).slice(0, 3);
    console.info(`  ${i + 1}. [${entry.capture.method}] ${entry.capture.url.slice(0, 110)}`);
    for (const candidate of top) {
      console.info(`       ${candidate.path} = ${candidate.value} ${candidate.currency ?? ''}`);
    }
  });

  const best = ranked[0];
  const suggestion = best ? suggestEndpoint(best.capture) : null;
  if (!suggestion) return;

  const suggestedFile = './data/endpoint.suggested.json';
  writeFileSync(suggestedFile, JSON.stringify(suggestion, null, 2), 'utf8');
  console.info('');
  console.info(`Suggested endpoint template → ${suggestedFile}`);
  console.info('Next steps:');
  console.info(`  1. Open it and replace your dates/occupancy with placeholders:`);
  console.info(`     {checkIn} {checkOut} {nights} {adults} {children} {childAges} {currency}`);
  console.info(`  2. Check offersPath/pricePath/labelPath point at the right fields.`);
  console.info(`  3. cp ${suggestedFile} ${cfg.TRACKER_ENDPOINT_FILE}`);
  console.info(`  4. TRACKER_SOURCE=api pnpm scan   # one sweep, prints what it found`);
}

/** True only when this file was run directly, so importing it in tests is safe. */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
