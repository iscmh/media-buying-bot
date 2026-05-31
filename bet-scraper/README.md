# bet-scraper

Interactive command-line tool that scrapes match **predictions / bets** from
[todaymatchprediction.com](https://www.todaymatchprediction.com) so you can use
them as a reference when betting on stake.bet.

You run one command, pick a sport, pick the games you care about, and it prints
every prediction/market it can find for those matches (and optionally saves them
to JSON).

> ⚠️ Predictions on that site are **tips, not guarantees**. This tool just
> collects public info faster — it does not place bets and it can't tell the
> future. Bet responsibly.

---

## Requirements

- macOS (or Linux/Windows) with **Node.js ≥ 20** (you have Node via the repo
  already).
- About 150 MB free for the headless browser Playwright downloads on first
  install.

## Install

```bash
cd bet-scraper
npm install          # installs deps AND downloads the headless Chromium browser
```

If the browser download is skipped or fails, run it manually:

```bash
npx playwright install chromium
```

## Usage

```bash
npm start
```

That's it — it will:

1. Launch a headless browser and open the site.
2. Ask **which sport** (the list is discovered from the site's own menu).
3. Show the matches it found; **pick the games** you want (space to toggle,
   enter to confirm — enter with nothing selected scrapes the first ones shown).
4. Print all the predictions/markets it can extract for each match.

### Options

```bash
npm start -- --help
```

| Option              | What it does                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `-s, --sport <name>`| Skip the sport prompt, e.g. `--sport football` (scrapes top games) |
| `-n, --limit <n>`   | Max matches to scrape when not picking manually (default 15)       |
| `--json [file]`     | Also write results to a JSON file (default `bets.json`)            |
| `--headed`          | Show the actual browser window (watch it work / debug)             |
| `--debug`           | Save rendered HTML + screenshots into `./debug` for tuning         |

Examples:

```bash
npm start -- --sport football --limit 10 --json today.json
npm start -- --headed --debug
```

---

## If it finds no sports or no bets

This scraper was written **without** being able to load the live site (it was
built in a sandbox whose network blocks the host), so the CSS selectors are
best-effort. The fix is quick:

1. Re-run with `--debug` (and `--headed` to watch). It saves the rendered page
   to `./debug/*.html` and a screenshot to `./debug/*.png`.
2. Open the HTML, find the real class names / structure for the nav, the match
   list, and the prediction tables.
3. Edit `config.json` → `selectors` accordingly. Each selector accepts a
   comma-separated list of CSS selectors; the code also falls back to generic
   heuristics (tables, `label: value` text, bold-label blocks).

If you send me one of those `debug/*.html` files, I can harden the selectors so
it works without any tuning.

## How it works

- `src/browser.ts` — launches Playwright Chromium with a realistic user agent /
  viewport to get past basic anti-bot checks.
- `src/scrape.ts` — `discoverSports` (reads the nav), `listMatches` (finds
  fixture links), `scrapeMatch` (pulls teams, league, kickoff, and bet markets).
- `src/index.ts` — the interactive CLI flow and output.
- `config.json` — base URL, known sport keywords, and tunable selectors.

## Notes on responsible use

This is for personal reference. It runs a single browser, visits pages
sequentially with small delays, and doesn't hammer the site. Don't crank the
limit to scrape the whole site, and check the site's terms.
