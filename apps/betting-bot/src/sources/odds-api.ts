/**
 * The Odds API (the-odds-api.com) client — aggregated odds from 30+ books.
 * Free tier: 500 requests/month. Set ODDS_API_KEY.
 */

import { z } from 'zod';
import type { GameOdds } from '../types.js';
import { americanToDecimal } from '../core/odds-math.js';

const BASE = 'https://api.the-odds-api.com/v4';

const outcomeSchema = z.object({
  name: z.string(),
  price: z.number(),
  point: z.number().optional(),
});

const eventSchema = z.object({
  id: z.string(),
  sport_key: z.string(),
  sport_title: z.string(),
  commence_time: z.string(),
  home_team: z.string(),
  away_team: z.string(),
  bookmakers: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      last_update: z.string().optional(),
      markets: z.array(
        z.object({
          key: z.string(),
          outcomes: z.array(outcomeSchema),
        }),
      ),
    }),
  ),
});

const sportSchema = z.object({
  key: z.string(),
  title: z.string(),
  group: z.string(),
  active: z.boolean(),
});

export type OddsApiSport = z.infer<typeof sportSchema>;

async function get(path: string, apiKey: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}apiKey=${apiKey}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function listSports(apiKey: string): Promise<OddsApiSport[]> {
  const data = await get('/sports', apiKey);
  return z.array(sportSchema).parse(data);
}

/**
 * Fetch upcoming odds for a sport (e.g. "americanfootball_nfl",
 * "americanfootball_ncaaf", "baseball_mlb", "soccer_epl").
 */
export async function fetchOdds(
  apiKey: string,
  sportKey: string,
  markets = 'h2h,spreads,totals',
): Promise<GameOdds[]> {
  const data = await get(
    `/sports/${sportKey}/odds?regions=us,us2,eu&markets=${markets}&oddsFormat=american`,
    apiKey,
  );
  const events = z.array(eventSchema).parse(data);

  return events.map((event) => ({
    id: event.id,
    sportKey: event.sport_key,
    sportTitle: event.sport_title,
    commenceTime: event.commence_time,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    books: event.bookmakers.flatMap((book) =>
      book.markets.map((market) => ({
        bookmaker: book.key,
        market: market.key,
        lastUpdate: book.last_update,
        outcomes: market.outcomes.map((o) => ({
          name: o.name,
          decimal: americanToDecimal(o.price),
          point: o.point,
        })),
      })),
    ),
  }));
}
