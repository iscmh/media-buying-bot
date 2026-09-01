/**
 * CLI entry point.
 *
 *   pnpm --filter @mbb/betting-bot scan -- --sport americanfootball_nfl --bankroll 1000
 *   pnpm --filter @mbb/betting-bot scan -- --source espn --sport nfl
 *   pnpm --filter @mbb/betting-bot sports          # list Odds API sport keys
 *
 * Env: ODDS_API_KEY (the-odds-api.com) for full multi-book scans,
 *      ANTHROPIC_API_KEY for the --ai review layer.
 */

import { DEFAULT_CONFIG, type GameOdds } from './types.js';
import { fetchOdds, listSports } from './sources/odds-api.js';
import { fetchEspnScoreboard } from './sources/espn.js';
import { scanGames } from './core/edge.js';
import { renderReport } from './report.js';
import { reviewBets } from './ai/analyst.js';

interface CliArgs {
  command: string;
  flags: Map<string, string>;
  bools: Set<string>;
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'scan';
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(name, next);
      i++;
    } else {
      bools.add(name);
    }
  }
  return { command, flags, bools };
}

async function runScan(args: CliArgs): Promise<void> {
  const source = args.flags.get('source') ?? 'odds-api';
  const sport = args.flags.get('sport') ?? 'americanfootball_nfl';

  const config = {
    ...DEFAULT_CONFIG,
    bankroll: Number(args.flags.get('bankroll') ?? DEFAULT_CONFIG.bankroll),
    minEdge: Number(args.flags.get('edge') ?? DEFAULT_CONFIG.minEdge),
    kellyFraction: Number(args.flags.get('kelly') ?? DEFAULT_CONFIG.kellyFraction),
  };

  let games: GameOdds[];
  if (source === 'espn') {
    games = await fetchEspnScoreboard(sport);
    console.error(
      'note: ESPN source is single-book — edges cannot be computed, ' +
        'showing market snapshot only. Use ODDS_API_KEY for real scans.',
    );
  } else {
    const apiKey = process.env['ODDS_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'ODDS_API_KEY is not set. Get a free key at https://the-odds-api.com ' +
          'or run with --source espn for a keyless (single-book) snapshot.',
      );
    }
    games = await fetchOdds(apiKey, sport);
  }

  console.error(`Fetched ${games.length} upcoming games for ${sport}.`);
  const bets = scanGames(games, config);

  if (args.bools.has('ai') && bets.length > 0) {
    if (!process.env['ANTHROPIC_API_KEY']) {
      console.error('warning: ANTHROPIC_API_KEY not set — skipping AI review.');
    } else {
      console.error(`Running AI risk review on ${bets.length} bet(s)…`);
      await reviewBets(bets, { extraContext: args.flags.get('context') });
    }
  }

  if (args.bools.has('json')) {
    console.info(
      JSON.stringify(
        bets.map(({ game, ...rest }) => ({
          ...rest,
          gameId: game.id,
          matchup: `${game.awayTeam} @ ${game.homeTeam}`,
          commenceTime: game.commenceTime,
        })),
        null,
        2,
      ),
    );
  } else {
    console.info(renderReport(bets, config.bankroll));
  }
}

async function runSports(): Promise<void> {
  const apiKey = process.env['ODDS_API_KEY'];
  if (!apiKey) throw new Error('ODDS_API_KEY is not set.');
  const sports = await listSports(apiKey);
  for (const sport of sports.filter((s) => s.active)) {
    console.info(`${sport.key.padEnd(40)} ${sport.group} — ${sport.title}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'scan':
      await runScan(args);
      break;
    case 'sports':
      await runSports();
      break;
    default:
      throw new Error(`Unknown command: ${args.command}. Use scan | sports.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
