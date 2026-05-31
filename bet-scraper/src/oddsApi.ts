import type { OddsApiSport, OddsEvent } from './types.js';

const BASE = 'https://api.the-odds-api.com/v4';

async function get<T>(path: string, params: Record<string, string>, key: string): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('apiKey', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('The Odds API rejected the key (401). Check ODDS_API_KEY.');
    if (res.status === 429) throw new Error('The Odds API quota exceeded (429).');
    throw new Error(`The Odds API ${res.status}: ${body.slice(0, 200)}`);
  }
  // Quota headers are handy to surface.
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining) process.env.__ODDS_REMAINING = remaining;
  return (await res.json()) as T;
}

export async function getSports(key: string): Promise<OddsApiSport[]> {
  const sports = await get<OddsApiSport[]>('/sports', {}, key);
  // Only active leagues; skip futures/outrights which have no per-match h2h.
  return sports.filter((s) => s.active && !s.has_outrights);
}

export async function getOdds(
  key: string,
  sportKey: string,
  regions: string,
): Promise<OddsEvent[]> {
  return get<OddsEvent[]>(
    `/sports/${sportKey}/odds`,
    { regions, markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso' },
    key,
  );
}

export function quotaRemaining(): string | undefined {
  return process.env.__ODDS_REMAINING;
}
