export interface Config {
  baseUrl: string;
  knownSports: string[];
  selectors: {
    navLinks: string;
    matchLinks: string;
    matchContainer: string;
    teams: string;
    league: string;
    kickoff: string;
    predictionBlocks: string;
  };
}

export interface Sport {
  name: string;
  url: string;
}

export interface MatchLink {
  title: string;
  url: string;
}

/** A single named bet / prediction market extracted from a match page. */
export interface Bet {
  market: string;
  value: string;
}

export interface MatchPrediction {
  title: string;
  url: string;
  teams?: string;
  league?: string;
  kickoff?: string;
  bets: Bet[];
}

export interface CliOptions {
  sport?: string;
  limit: number;
  debug: boolean;
  headed: boolean;
  json?: string;
}
