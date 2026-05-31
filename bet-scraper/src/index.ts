#!/usr/bin/env -S npx tsx
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkbox, select } from '@inquirer/prompts';
import { launchBrowser } from './browser.js';
import { dumpDebug } from './debug.js';
import { discoverSports, listMatches, scrapeMatch } from './scrape.js';
import type { CliOptions, Config, MatchPrediction } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { limit: 15, debug: false, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--sport':
      case '-s':
        opts.sport = argv[++i];
        break;
      case '--limit':
      case '-n':
        opts.limit = Number(argv[++i]) || opts.limit;
        break;
      case '--json':
        opts.json = argv[++i] ?? 'bets.json';
        break;
      case '--debug':
        opts.debug = true;
        break;
      case '--headed':
        opts.headed = true;
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
  console.log(`bet-scraper — scrape match predictions/bets from todaymatchprediction.com

Usage: npm start -- [options]

Options:
  -s, --sport <name>   Skip the sport prompt (e.g. --sport football)
  -n, --limit <n>      Max matches to scrape when not picking manually (default 15)
      --json [file]    Also write results to a JSON file (default bets.json)
      --headed         Show the browser window (useful for debugging)
      --debug          Save rendered HTML + screenshots to ./debug
  -h, --help           Show this help
`);
}

async function loadConfig(): Promise<Config> {
  const raw = await readFile(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw) as Config;
}

function printMatch(m: MatchPrediction): void {
  console.log('');
  console.log(`\x1b[1m${m.teams || m.title}\x1b[0m`);
  const meta = [m.league, m.kickoff].filter(Boolean).join('  •  ');
  if (meta) console.log(`  ${meta}`);
  console.log(`  ${m.url}`);
  if (m.bets.length === 0) {
    console.log('  \x1b[33m(no bets/markets found — try --debug to inspect the page)\x1b[0m');
    return;
  }
  for (const b of m.bets) {
    console.log(`  \x1b[36m${b.market}\x1b[0m: ${b.value}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = await loadConfig();

  console.log('Launching headless browser…');
  const { browser, context } = await launchBrowser(opts.headed);
  const page = await context.newPage();

  try {
    console.log(`Discovering sports on ${config.baseUrl} …`);
    const sports = await discoverSports(page, config);
    if (opts.debug) await dumpDebug(page, 'homepage');

    if (sports.length === 0) {
      console.error(
        '\x1b[31mNo sports found in the site navigation.\x1b[0m\n' +
          'The page structure may differ from the defaults. Re-run with --debug, ' +
          'inspect ./debug/*.html, and update "selectors.navLinks" in config.json.',
      );
      return;
    }

    // Pick the sport (from flag or interactive prompt).
    let chosen = opts.sport
      ? sports.find((s) => s.name.toLowerCase().includes(opts.sport!.toLowerCase()))
      : undefined;
    if (!chosen) {
      chosen = await select({
        message: 'Which sport?',
        choices: sports.map((s) => ({ name: s.name, value: s })),
      });
    }
    console.log(`\nFetching matches for ${chosen.name} …`);
    const matches = await listMatches(page, chosen.url, config);
    if (opts.debug) await dumpDebug(page, `${chosen.name}-list`);

    if (matches.length === 0) {
      console.error(
        '\x1b[31mNo matches found on the sport page.\x1b[0m\n' +
          'Re-run with --debug and update "selectors.matchLinks" in config.json.',
      );
      return;
    }

    // Let the user pick which matches to scrape (default: first <limit>).
    let toScrape = matches.slice(0, opts.limit);
    if (!opts.sport) {
      const picked = await checkbox({
        message: `Found ${matches.length} matches. Pick the ones you want (space to toggle, enter for all shown):`,
        choices: matches.slice(0, 40).map((m) => ({ name: m.title, value: m })),
        pageSize: 15,
      });
      if (picked.length > 0) toScrape = picked;
    }

    console.log(`\nScraping ${toScrape.length} match(es)…`);
    const results: MatchPrediction[] = [];
    for (const m of toScrape) {
      process.stdout.write(`  • ${m.title.slice(0, 60)} … `);
      try {
        const result = await scrapeMatch(page, m, config);
        if (opts.debug && result.bets.length === 0) await dumpDebug(page, m.title);
        results.push(result);
        console.log(`${result.bets.length} markets`);
      } catch (err) {
        console.log(`\x1b[31mfailed (${(err as Error).message})\x1b[0m`);
      }
    }

    console.log('\n========== PREDICTIONS / BETS ==========');
    for (const r of results) printMatch(r);
    console.log('\n========================================');
    console.log('\x1b[2mReminder: predictions are tips, not guarantees. Bet responsibly.\x1b[0m');

    if (opts.json) {
      await writeFile(opts.json, JSON.stringify(results, null, 2), 'utf8');
      console.log(`\nSaved JSON → ${opts.json}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('\x1b[31mFatal:\x1b[0m', err);
  process.exit(1);
});
