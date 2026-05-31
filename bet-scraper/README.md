# bet-scraper

Interactive command-line tool that pulls **real betting data from APIs** so you
can use it as a reference when betting on stake.bet:

- **Market odds** from [The Odds API](https://the-odds-api.com) → de-vigged
  **consensus probabilities** across many bookmakers (the most reliable signal
  there is — efficient markets beat tipster sites).
- **Model predictions** from [API-Football](https://www.api-football.com) →
  win/draw/away % + advice (soccer only).

You run one command, pick a sport → league → the games you want, and it prints
the market's true probability for each outcome, the **best price** available
(line-shopping), a **+EV flag** when a price beats fair value, and the model's
prediction.

> ⚠️ These are probabilities and tips, not guarantees. The tool doesn't place
> bets and can't see the future. Bet responsibly.

---

## Why APIs instead of scraping todaymatchprediction.com?

Tipster prediction sites are low-signal and fight you with anti-bot. De-vigged
odds from real bookmakers are a far better forecast, come as clean JSON, and
don't break when a site changes its HTML. (The old Playwright scraper was
removed — check git history if you ever want it back.)

## Setup

Requires **Node.js ≥ 20** (you have it via the repo).

```bash
cd bet-scraper
npm install
cp .env.example .env       # then paste your API keys into .env
```

Get keys (both have free tiers):

- **ODDS_API_KEY** (required) — sign up at https://the-odds-api.com (~500 req/mo free).
- **API_FOOTBALL_KEY** (optional, soccer model %) — https://www.api-football.com
  (~100 req/day free). Use the **direct api-sports.io** key, not a RapidAPI key.

## Usage

```bash
npm start
```

It will:

1. List sports/leagues from The Odds API → you pick **sport**, then **league**.
2. Show upcoming games → you **pick the ones you want** (space toggles, enter
   confirms; enter with none selected uses all shown).
3. Print, per game:
   - **Market consensus**: de-vigged probability per outcome + best odds & book.
   - **+EV flag** when the best price implies value vs the consensus.
   - **Model** (soccer, if `API_FOOTBALL_KEY` set): winner, home/draw/away %, advice.

### Options

```bash
npm start -- --help
```

| Option              | What it does                                                  |
| ------------------- | ------------------------------------------------------------- |
| `-s, --sport <text>`| Pre-filter the league list, e.g. `--sport epl`                |
| `--regions <r>`     | Bookmaker regions for odds (default `eu,uk`; also `us`, `au`) |
| `-n, --limit <n>`   | Max events listed per league (default 25)                     |
| `--json [file]`     | Also write results to JSON (default `bets.json`)              |
| `--no-model`        | Odds only; skip API-Football                                  |

Examples:

```bash
npm start -- --sport epl --regions uk,eu --json today.json
npm start -- --no-model
```

## How it reads the numbers

- **Consensus probability** = for each bookmaker, implied probs (`1/odds`) are
  normalised to remove the margin ("de-vig"), then averaged across books. Summing
  across outcomes gives ~100%. This is the market's honest estimate.
- **+EV** = the best available decimal odds are higher than "fair" odds
  (`1/consensus prob`) by >3% → the line may be worth a bet. Use as a pointer,
  not gospel.
- **Model** = API-Football's statistical model (form, H2H, etc.). Cross-check it
  against the market rather than trusting it alone.

## Quotas

The tool surfaces your remaining Odds API requests after fetching. Model
predictions cost one API-Football call per *selected* game (plus one per
distinct day to list fixtures), so pick the games you care about rather than
scraping everything.

## Notes

These APIs were not reachable from the sandbox this was built in, so the
endpoint calls were written from their documented shapes and the math/matching
were unit-tested in isolation. If a response shape has drifted, it'll surface as
a clear error — send it my way and I'll adjust.
