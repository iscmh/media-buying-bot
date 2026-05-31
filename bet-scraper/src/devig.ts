import type { ConsensusOutcome, OddsEvent } from './types.js';

/**
 * Compute de-vigged consensus probabilities for an event's moneyline (h2h).
 *
 * For each bookmaker we take the implied probabilities (1/decimal odds) and
 * normalise them so they sum to 1 — this strips out the bookmaker's margin
 * ("the vig"). We then average each outcome's de-vigged probability across all
 * books, and separately track the best (highest) price on offer for each
 * outcome so you can line-shop.
 */
export function consensus(event: OddsEvent): ConsensusOutcome[] {
  const probSums = new Map<string, number>();
  const probCounts = new Map<string, number>();
  const best = new Map<string, { price: number; book: string }>();

  for (const book of event.bookmakers) {
    const h2h = book.markets.find((m) => m.key === 'h2h');
    if (!h2h || h2h.outcomes.length === 0) continue;

    // Implied probs for this book, then normalise to remove the vig.
    const implied = h2h.outcomes.map((o) => (o.price > 0 ? 1 / o.price : 0));
    const overround = implied.reduce((a, b) => a + b, 0);
    if (overround <= 0) continue;

    h2h.outcomes.forEach((o, i) => {
      const fair = (implied[i] ?? 0) / overround;
      probSums.set(o.name, (probSums.get(o.name) ?? 0) + fair);
      probCounts.set(o.name, (probCounts.get(o.name) ?? 0) + 1);

      const cur = best.get(o.name);
      if (!cur || o.price > cur.price) best.set(o.name, { price: o.price, book: book.title });
    });
  }

  const outcomes: ConsensusOutcome[] = [];
  for (const [name, sum] of probSums) {
    const count = probCounts.get(name) ?? 1;
    const b = best.get(name);
    outcomes.push({
      name,
      consensusProb: sum / count,
      bestPrice: b?.price ?? 0,
      bestBook: b?.book ?? '',
      books: count,
    });
  }
  // Highest probability first.
  outcomes.sort((a, b) => b.consensusProb - a.consensusProb);
  return outcomes;
}

/** Fair decimal odds implied by a probability (1/p). Useful for spotting value. */
export function fairOdds(prob: number): number {
  return prob > 0 ? 1 / prob : 0;
}
