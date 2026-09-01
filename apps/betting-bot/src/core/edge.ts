/**
 * Edge scanner: for every outcome of every game, compare the best available
 * retail price against the sharp-consensus fair price and flag +EV outliers.
 */

import type { GameOdds, ScanConfig, ValueBet } from '../types.js';
import { consensusForMarket, outcomeKey } from './consensus.js';
import { decimalToAmerican } from './odds-math.js';
import { expectedValue, kellyFraction, recommendedStake } from './kelly.js';

export function scanGame(game: GameOdds, config: ScanConfig): ValueBet[] {
  const bets: ValueBet[] = [];
  const marketTypes = [...new Set(game.books.map((b) => b.market))];

  for (const market of marketTypes) {
    const marketBooks = game.books.filter((b) => b.market === market);
    const fair = consensusForMarket(marketBooks, config);

    for (const [key, fairOutcome] of fair) {
      // Best available price for this exact outcome+line across books.
      let bestDecimal = 0;
      let bestBook = '';
      for (const book of marketBooks) {
        for (const outcome of book.outcomes) {
          if (outcomeKey(outcome.name, outcome.point) !== key) continue;
          if (outcome.decimal > bestDecimal) {
            bestDecimal = outcome.decimal;
            bestBook = book.bookmaker;
          }
        }
      }
      if (bestDecimal <= 1) continue;

      const ev = expectedValue(fairOutcome.fairProb, bestDecimal);
      if (ev < config.minEdge) continue;

      bets.push({
        game,
        market,
        outcome: fairOutcome.name,
        point: fairOutcome.point,
        bestDecimal,
        bestAmerican: decimalToAmerican(bestDecimal),
        bestBook,
        fairProb: fairOutcome.fairProb,
        fairDecimal: fairOutcome.fairDecimal,
        ev,
        kelly: kellyFraction(fairOutcome.fairProb, bestDecimal),
        stake: recommendedStake(fairOutcome.fairProb, bestDecimal, {
          bankroll: config.bankroll,
          kellyMultiplier: config.kellyFraction,
          maxStakePct: config.maxStakePct,
        }),
        bookCount: fairOutcome.bookCount,
      });
    }
  }

  return bets.sort((a, b) => b.ev - a.ev);
}

export function scanGames(games: GameOdds[], config: ScanConfig): ValueBet[] {
  return games.flatMap((g) => scanGame(g, config)).sort((a, b) => b.ev - a.ev);
}
