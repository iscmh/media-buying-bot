#!/usr/bin/env -S npx tsx
import { writeFile } from 'node:fs/promises';
import { checkbox, select } from '@inquirer/prompts';
import { consensus, fairOdds } from './devig.js';
import { getFixturesByDate, getPrediction } from './footballApi.js';
import { getOdds, getSports, quotaRemaining } from './oddsApi.js';
import { matchFixture } from './match.js';
import type { CliOptions, MatchReport, OddsApiSport, OddsEvent } from './types.js';

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { regions: 'eu,uk', limit: 25, noModel: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--sport':
      case '-s':
        opts.sport = argv[++i];
        break;
      case '--regions':
        opts.regions = argv[++i] ?? opts.regions;
        break;
      case '--limit':
      case '-n':
        opts.limit = Number(argv[++i]) || opts.limit;
        break;
      case '--json':
        opts.json = argv[++i] ?? 'bets.json';
        break;
      case '--no-model':
        opts.noModel = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`bet-scraper — market odds (The Odds API) + model predictions (API-Football)

Setup: copy .env.example to .env and add your API keys, then:

Usage: npm start -- [options]

Options:
  -s, --sport <text>   Pre-filter the league list (e.g. --sport epl)
      --regions <r>    Bookmaker regions for odds (default eu,uk; also us,au)
  -n, --limit <n>      Max events to list per league (default 25)
      --json [file]    Also write results to JSON (default bets.json)
      --no-model       Skip API-Football model predictions (odds only)
  -h, --help           Show this help
`);
}

function loadEnv(): void {
  try {
    // Node >= 20.6 native .env loader; ignore if no file.
    process.loadEnvFile?.('.env');
  } catch {
    /* no .env file — rely on real env vars */
  }
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function printReport(r: MatchReport): void {
  console.log('');
  const when = new Date(r.commenceTime).toLocaleString();
  console.log(`\x1b[1m${r.home} vs ${r.away}\x1b[0m`);
  console.log(`  \x1b[2m${r.league}  •  ${when}\x1b[0m`);

  console.log('  \x1b[36mMarket (de-vigged consensus across books):\x1b[0m');
  for (const o of r.market) {
    const edge = o.bestPrice > 0 ? o.bestPrice / fairOdds(o.consensusProb) : 0;
    const value = edge > 1.03 ? `  \x1b[32m← +EV vs fair\x1b[0m` : '';
    console.log(
      `    ${o.name.padEnd(22)} ${pct(o.consensusProb).padStart(6)}  ` +
        `best ${o.bestPrice.toFixed(2)} @ ${o.bestBook} (${o.books} books)${value}`,
    );
  }

  if (r.model) {
    const m = r.model;
    console.log('  \x1b[35mModel (API-Football):\x1b[0m');
    console.log(
      `    winner: ${m.winner ?? 'n/a'}   ` +
        `home ${m.percent.home ?? '?'} / draw ${m.percent.draw ?? '?'} / away ${m.percent.away ?? '?'}`,
    );
    if (m.advice) console.log(`    advice: ${m.advice}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  loadEnv();

  const oddsKey = process.env.ODDS_API_KEY;
  if (!oddsKey) {
    console.error('\x1b[31mMissing ODDS_API_KEY.\x1b[0m Copy .env.example to .env and add your key.');
    process.exit(1);
  }
  const footballKey = process.env.API_FOOTBALL_KEY;

  console.log('Fetching available sports/leagues from The Odds API…');
  let sports = await getSports(oddsKey);
  if (opts.sport) {
    const q = opts.sport.toLowerCase();
    sports = sports.filter(
      (s) => s.group.toLowerCase().includes(q) || s.title.toLowerCase().includes(q) || s.key.includes(q),
    );
  }
  if (sports.length === 0) {
    console.error('No matching leagues found.');
    return;
  }

  // Pick a sport group, then a league within it.
  const groups = [...new Set(sports.map((s) => s.group))].sort();
  const group =
    groups.length === 1
      ? groups[0]!
      : await select({ message: 'Which sport?', choices: groups.map((g) => ({ name: g, value: g })) });

  const leagues = sports.filter((s) => s.group === group);
  const league: OddsApiSport =
    leagues.length === 1
      ? leagues[0]!
      : await select({
          message: `Which ${group} league?`,
          choices: leagues.map((s) => ({ name: `${s.title} (${s.description})`, value: s })),
          pageSize: 15,
        });

  console.log(`\nFetching odds for ${league.title}…`);
  const events = await getOdds(oddsKey, league.key, opts.regions);
  if (events.length === 0) {
    console.log('No upcoming events with odds for that league right now.');
    return;
  }
  const remaining = quotaRemaining();
  if (remaining) console.log(`(Odds API requests remaining: ${remaining})`);

  // Let the user pick which games they want.
  const shown = events.slice(0, opts.limit);
  const picked = await checkbox<OddsEvent>({
    message: `Found ${events.length} events. Pick games (space to toggle, enter for all shown):`,
    choices: shown.map((e) => ({
      name: `${e.home_team} vs ${e.away_team}  —  ${new Date(e.commence_time).toLocaleString()}`,
      value: e,
    })),
    pageSize: 15,
  });
  const chosen = picked.length > 0 ? picked : shown;

  // Build base reports from odds.
  const reports: MatchReport[] = chosen.map((e) => ({
    eventId: e.id,
    league: league.title,
    commenceTime: e.commence_time,
    home: e.home_team,
    away: e.away_team,
    market: consensus(e),
  }));

  // Layer in model predictions for soccer when a key is present.
  const wantModel = !opts.noModel && group.toLowerCase() === 'soccer';
  if (wantModel && !footballKey) {
    console.log('\n\x1b[33m(No API_FOOTBALL_KEY set — showing odds only. Add it for model predictions.)\x1b[0m');
  } else if (wantModel && footballKey) {
    console.log('\nFetching model predictions (API-Football)…');
    const days = [...new Set(chosen.map((e) => e.commence_time.slice(0, 10)))];
    const fixtures = (
      await Promise.all(days.map((d) => getFixturesByDate(d, footballKey).catch(() => [])))
    ).flat();

    for (const r of reports) {
      const event = chosen.find((e) => e.id === r.eventId)!;
      const fixtureId = matchFixture(event, fixtures);
      if (!fixtureId) continue;
      try {
        r.model = await getPrediction(fixtureId, footballKey);
      } catch (err) {
        console.log(`  \x1b[33mprediction failed for ${r.home} vs ${r.away}: ${(err as Error).message}\x1b[0m`);
      }
    }
  }

  console.log('\n================ REPORT ================');
  for (const r of reports) printReport(r);
  console.log('\n=======================================');
  console.log(
    '\x1b[2mConsensus prob = market de-vigged across books (a strong baseline). ' +
      'Model = API-Football stats model. Neither guarantees outcomes — bet responsibly.\x1b[0m',
  );

  if (opts.json) {
    await writeFile(opts.json, JSON.stringify(reports, null, 2), 'utf8');
    console.log(`\nSaved JSON → ${opts.json}`);
  }
}

main().catch((err) => {
  console.error('\x1b[31mFatal:\x1b[0m', (err as Error).message);
  process.exit(1);
});
