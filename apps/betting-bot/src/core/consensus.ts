/**
 * Sharp-weighted consensus: combine de-vigged probabilities from every book
 * quoting the same market into one "fair" probability per outcome.
 */

import type { BookMarket, FairOutcome, ScanConfig } from '../types.js';
import { devig } from './odds-math.js';

/** Key that identifies one tradeable outcome within a market. */
export function outcomeKey(name: string, point?: number): string {
  return point === undefined ? name : `${name}@${point}`;
}

interface WeightedProb {
  prob: number;
  weight: number;
}

/** Weighted median — robust against one book posting an off-market line. */
export function weightedMedian(values: WeightedProb[]): number {
  const sorted = [...values].sort((a, b) => a.prob - b.prob);
  const totalWeight = sorted.reduce((s, v) => s + v.weight, 0);
  let cumulative = 0;
  for (const v of sorted) {
    cumulative += v.weight;
    if (cumulative >= totalWeight / 2) return v.prob;
  }
  const last = sorted[sorted.length - 1];
  return last ? last.prob : 0;
}

/**
 * Build consensus fair probabilities for one market type of one game.
 * Books quoting a different `point` (line) form separate outcome groups —
 * a -3.5 spread is not comparable to a -2.5 spread.
 */
export function consensusForMarket(
  books: BookMarket[],
  config: Pick<ScanConfig, 'sharpBooks' | 'sharpWeight' | 'minBooks'>,
): Map<string, FairOutcome> {
  const byOutcome = new Map<string, WeightedProb[]>();
  const meta = new Map<string, { name: string; point?: number }>();

  for (const book of books) {
    if (book.outcomes.length < 2) continue;
    const fairProbs = devig(book.outcomes.map((o) => o.decimal));
    const isSharp = config.sharpBooks.includes(book.bookmaker.toLowerCase());
    const weight = isSharp ? config.sharpWeight : 1;

    book.outcomes.forEach((outcome, i) => {
      const prob = fairProbs[i];
      if (prob === undefined) return;
      const key = outcomeKey(outcome.name, outcome.point);
      if (!byOutcome.has(key)) {
        byOutcome.set(key, []);
        meta.set(key, { name: outcome.name, point: outcome.point });
      }
      byOutcome.get(key)?.push({ prob, weight });
    });
  }

  const result = new Map<string, FairOutcome>();
  for (const [key, probs] of byOutcome) {
    if (probs.length < config.minBooks) continue;
    const info = meta.get(key);
    if (!info) continue;
    const fairProb = weightedMedian(probs);
    if (fairProb <= 0 || fairProb >= 1) continue;
    result.set(key, {
      name: info.name,
      point: info.point,
      fairProb,
      fairDecimal: 1 / fairProb,
      bookCount: probs.length,
    });
  }
  return result;
}
