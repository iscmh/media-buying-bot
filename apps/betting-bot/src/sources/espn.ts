/**
 * ESPN public scoreboard API — free, no key. Gives schedules plus a single
 * book's odds (ESPN BET), so it can't power cross-book edge detection, but
 * it lets the bot run with zero configuration and supplies game context.
 */

import { z } from 'zod';
import type { GameOdds } from '../types.js';
import { americanToDecimal } from '../core/odds-math.js';

export const ESPN_LEAGUES: Record<string, { sport: string; league: string }> = {
  nfl: { sport: 'football', league: 'nfl' },
  ncaaf: { sport: 'football', league: 'college-football' },
  mlb: { sport: 'baseball', league: 'mlb' },
  nba: { sport: 'basketball', league: 'nba' },
  nhl: { sport: 'hockey', league: 'nhl' },
  epl: { sport: 'soccer', league: 'eng.1' },
};

const oddsSchema = z.object({
  details: z.string().optional(),
  overUnder: z.number().optional(),
  spread: z.number().optional(),
  provider: z.object({ name: z.string() }).optional(),
  homeTeamOdds: z.object({ moneyLine: z.number().optional() }).optional(),
  awayTeamOdds: z.object({ moneyLine: z.number().optional() }).optional(),
});

const eventSchema = z.object({
  id: z.string(),
  date: z.string(),
  name: z.string(),
  competitions: z.array(
    z.object({
      competitors: z.array(
        z.object({
          homeAway: z.string(),
          team: z.object({ displayName: z.string() }),
        }),
      ),
      odds: z.array(oddsSchema).optional(),
    }),
  ),
});

const scoreboardSchema = z.object({
  events: z.array(eventSchema),
});

export async function fetchEspnScoreboard(leagueKey: string): Promise<GameOdds[]> {
  const league = ESPN_LEAGUES[leagueKey];
  if (!league) {
    throw new Error(
      `Unknown ESPN league "${leagueKey}". Known: ${Object.keys(ESPN_LEAGUES).join(', ')}`,
    );
  }
  const url = `https://site.api.espn.com/apis/site/v2/sports/${league.sport}/${league.league}/scoreboard`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN API ${res.status} for ${url}`);
  const parsed = scoreboardSchema.parse(await res.json());

  const games: GameOdds[] = [];
  for (const event of parsed.events) {
    const competition = event.competitions[0];
    if (!competition) continue;
    const home = competition.competitors.find((c) => c.homeAway === 'home');
    const away = competition.competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;

    const game: GameOdds = {
      id: event.id,
      sportKey: leagueKey,
      sportTitle: leagueKey.toUpperCase(),
      commenceTime: event.date,
      homeTeam: home.team.displayName,
      awayTeam: away.team.displayName,
      books: [],
    };

    for (const odds of competition.odds ?? []) {
      const homeMl = odds.homeTeamOdds?.moneyLine;
      const awayMl = odds.awayTeamOdds?.moneyLine;
      if (homeMl && awayMl) {
        game.books.push({
          bookmaker: odds.provider?.name ?? 'espnbet',
          market: 'h2h',
          outcomes: [
            { name: home.team.displayName, decimal: americanToDecimal(homeMl) },
            { name: away.team.displayName, decimal: americanToDecimal(awayMl) },
          ],
        });
      }
    }
    games.push(game);
  }
  return games;
}
