/** Core domain types shared across the betting bot. */

/** American odds, e.g. -110, +145. */
export type AmericanOdds = number;

export interface OutcomePrice {
  /** Outcome label, e.g. team name, "Over", "Under". */
  name: string;
  /** Decimal odds (European), e.g. 1.91. */
  decimal: number;
  /** Spread / total line the price is attached to, if any. */
  point?: number;
}

export interface BookMarket {
  bookmaker: string;
  /** "h2h" (moneyline), "spreads", or "totals". */
  market: string;
  outcomes: OutcomePrice[];
  lastUpdate?: string;
}

export interface GameOdds {
  id: string;
  sportKey: string;
  sportTitle: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  books: BookMarket[];
}

export interface FairOutcome {
  name: string;
  point?: number;
  /** Consensus no-vig probability of this outcome. */
  fairProb: number;
  /** Fair decimal price implied by fairProb (1 / fairProb). */
  fairDecimal: number;
  /** Number of books contributing to the consensus. */
  bookCount: number;
}

export interface ValueBet {
  game: GameOdds;
  market: string;
  outcome: string;
  point?: number;
  /** Best available price across scanned books. */
  bestDecimal: number;
  bestAmerican: AmericanOdds;
  bestBook: string;
  fairProb: number;
  fairDecimal: number;
  /** Expected value per unit staked at the best price (e.g. 0.031 = +3.1%). */
  ev: number;
  /** Full-Kelly fraction of bankroll for this price/probability. */
  kelly: number;
  /** Recommended stake after fractional Kelly + cap. */
  stake: number;
  bookCount: number;
  /** Optional qualitative review from the AI analyst. */
  aiReview?: AiReview;
}

export interface AiReview {
  verdict: 'bet' | 'caution' | 'pass';
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  riskFlags: string[];
}

export interface ScanConfig {
  /** Minimum EV to flag, e.g. 0.02 = +2%. */
  minEdge: number;
  /** Kelly multiplier (0.25 = quarter Kelly). */
  kellyFraction: number;
  /** Hard cap on a single stake as a fraction of bankroll. */
  maxStakePct: number;
  bankroll: number;
  /** Books whose de-vigged prices anchor the consensus (weighted heavier). */
  sharpBooks: string[];
  /** Weight applied to sharp books in the consensus (others get 1). */
  sharpWeight: number;
  /** Minimum number of books required to trust a consensus. */
  minBooks: number;
}

export const DEFAULT_CONFIG: ScanConfig = {
  minEdge: 0.02,
  kellyFraction: 0.25,
  maxStakePct: 0.02,
  bankroll: 1000,
  sharpBooks: ['pinnacle', 'betonlineag', 'lowvig'],
  sharpWeight: 3,
  minBooks: 3,
};
