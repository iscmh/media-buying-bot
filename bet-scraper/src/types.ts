// ---- The Odds API ----------------------------------------------------------

export interface OddsApiSport {
  key: string; // e.g. "soccer_epl"
  group: string; // e.g. "Soccer"
  title: string; // e.g. "EPL"
  description: string;
  active: boolean;
  has_outrights: boolean;
}

export interface OddsOutcome {
  name: string;
  price: number; // decimal odds
  point?: number;
}

export interface OddsMarket {
  key: string; // "h2h", "spreads", "totals"
  outcomes: OddsOutcome[];
}

export interface OddsBookmaker {
  key: string;
  title: string;
  markets: OddsMarket[];
}

export interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string; // ISO
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

// ---- API-Football -----------------------------------------------------------

export interface FootballFixture {
  fixtureId: number;
  date: string;
  home: string;
  away: string;
  league: string;
}

export interface FootballPrediction {
  winner?: string;
  advice?: string;
  percent: { home?: string; draw?: string; away?: string };
}

// ---- Internal model ---------------------------------------------------------

/** A de-vigged consensus probability + the best available price for one outcome. */
export interface ConsensusOutcome {
  name: string;
  consensusProb: number; // 0..1, averaged & de-vigged across books
  bestPrice: number; // highest decimal odds found
  bestBook: string;
  books: number; // how many bookmakers contributed
}

export interface MatchReport {
  eventId: string;
  league: string;
  commenceTime: string;
  home: string;
  away: string;
  market: ConsensusOutcome[];
  model?: FootballPrediction;
}

export interface CliOptions {
  sport?: string; // pre-filter group/league text
  regions: string;
  limit: number;
  json?: string;
  noModel: boolean;
}
