import { describe, expect, it } from 'vitest';
import { scanGames } from '../src/core/edge.js';
import { consensusForMarket, weightedMedian } from '../src/core/consensus.js';
import { americanToDecimal } from '../src/core/odds-math.js';
import { DEFAULT_CONFIG, type BookMarket, type GameOdds } from '../src/types.js';

function h2hBook(bookmaker: string, homePrice: number, awayPrice: number): BookMarket {
  return {
    bookmaker,
    market: 'h2h',
    outcomes: [
      { name: 'Home', decimal: americanToDecimal(homePrice) },
      { name: 'Away', decimal: americanToDecimal(awayPrice) },
    ],
  };
}

function game(books: BookMarket[]): GameOdds {
  return {
    id: 'g1',
    sportKey: 'test',
    sportTitle: 'TEST',
    commenceTime: '2026-09-05T00:00:00Z',
    homeTeam: 'Home',
    awayTeam: 'Away',
    books,
  };
}

describe('weightedMedian', () => {
  it('returns the middle value for equal weights', () => {
    const median = weightedMedian([
      { prob: 0.4, weight: 1 },
      { prob: 0.5, weight: 1 },
      { prob: 0.9, weight: 1 },
    ]);
    expect(median).toBe(0.5);
  });

  it('pulls toward heavily weighted (sharp) values', () => {
    const median = weightedMedian([
      { prob: 0.4, weight: 5 },
      { prob: 0.6, weight: 1 },
      { prob: 0.9, weight: 1 },
    ]);
    expect(median).toBe(0.4);
  });
});

describe('consensusForMarket', () => {
  it('requires minBooks books', () => {
    const fair = consensusForMarket([h2hBook('a', -110, -110)], {
      ...DEFAULT_CONFIG,
      minBooks: 3,
    });
    expect(fair.size).toBe(0);
  });

  it('produces ~50/50 for a symmetric market', () => {
    const books = ['a', 'b', 'c'].map((name) => h2hBook(name, -110, -110));
    const fair = consensusForMarket(books, DEFAULT_CONFIG);
    expect(fair.get('Home')?.fairProb).toBeCloseTo(0.5, 2);
    expect(fair.get('Away')?.fairProb).toBeCloseTo(0.5, 2);
  });
});

describe('scanGames', () => {
  it('finds no edge when all books agree', () => {
    const books = ['a', 'b', 'c', 'd'].map((name) => h2hBook(name, -110, -110));
    const bets = scanGames([game(books)], DEFAULT_CONFIG);
    expect(bets).toHaveLength(0);
  });

  it('flags an outlier price as +EV', () => {
    const books = [
      h2hBook('pinnacle', -150, +130),
      h2hBook('a', -150, +130),
      h2hBook('b', -150, +130),
      // One retail book hangs a stale +170 on the away team.
      h2hBook('slowbook', -150, +170),
    ];
    const bets = scanGames([game(books)], { ...DEFAULT_CONFIG, minEdge: 0.02 });
    expect(bets.length).toBeGreaterThanOrEqual(1);
    const top = bets[0];
    expect(top?.outcome).toBe('Away');
    expect(top?.bestBook).toBe('slowbook');
    expect(top?.ev).toBeGreaterThan(0.02);
    expect(top?.stake).toBeGreaterThan(0);
  });

  it('suggests larger stakes for larger edges (before the cap)', () => {
    const mkBets = (outlier: number) =>
      scanGames(
        [
          game([
            h2hBook('pinnacle', -150, +130),
            h2hBook('a', -150, +130),
            h2hBook('b', -150, +130),
            h2hBook('slowbook', -150, outlier),
          ]),
        ],
        { ...DEFAULT_CONFIG, minEdge: 0.01, maxStakePct: 1 },
      );
    const small = mkBets(+150)[0];
    const large = mkBets(+180)[0];
    expect(small && large).toBeTruthy();
    expect(large!.stake).toBeGreaterThan(small!.stake);
  });
});
