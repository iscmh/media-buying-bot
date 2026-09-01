# @mbb/betting-bot

A sports betting **value scanner**, not a crystal ball. It implements the one
approach with real evidence behind it: market-based edge detection.

## How it works

1. **Ingest odds** from 30+ sportsbooks via [The Odds API](https://the-odds-api.com)
   (free tier: 500 req/mo), or a keyless single-book ESPN snapshot.
2. **De-vig** every book's market (multiplicative + power methods averaged) to
   recover each book's implied "fair" probabilities.
3. **Consensus**: weighted median of fair probabilities across books, with
   sharp books (Pinnacle et al.) weighted 3x. This is the bot's estimate of
   the true probability.
4. **Edge scan**: if some retail book's price beats the consensus fair price
   by ≥ 2% EV, flag it.
5. **Stake sizing**: quarter-Kelly, hard-capped at 2% of bankroll.
6. **AI risk review** (optional `--ai`): Claude reviews each flagged bet for
   qualitative risks the math can't see (injuries, weather, motivation,
   stale-line-because-news). It is a skeptic, not a tout — it will say
   "caution" when it has nothing concrete.

## Usage

```bash
# .env or shell
export ODDS_API_KEY=...        # the-odds-api.com
export ANTHROPIC_API_KEY=...   # only for --ai

# Full multi-book scan (NFL)
pnpm --filter @mbb/betting-bot scan -- --sport americanfootball_nfl --bankroll 1000

# College football, higher edge threshold, AI review on
pnpm --filter @mbb/betting-bot scan -- --sport americanfootball_ncaaf --edge 0.03 --ai

# Feed the AI current news you gathered
pnpm --filter @mbb/betting-bot scan -- --sport baseball_mlb --ai --context "Ace pitcher X scratched today"

# Machine-readable output
pnpm --filter @mbb/betting-bot scan -- --sport americanfootball_nfl --json

# No API key? Keyless single-book snapshot (no edges, market view only)
pnpm --filter @mbb/betting-bot scan -- --source espn --sport nfl

# List all sport keys
pnpm --filter @mbb/betting-bot sports
```

Common sport keys: `americanfootball_nfl`, `americanfootball_ncaaf`,
`baseball_mlb`, `basketball_nba`, `icehockey_nhl`, `soccer_epl`,
`soccer_uefa_champs_league`, `tennis_atp_us_open`.

Flags: `--sport`, `--bankroll` (default 1000), `--edge` (default 0.02),
`--kelly` (default 0.25), `--ai`, `--context "..."`, `--json`,
`--source espn|odds-api`.

## Why this design (and not "AI predicts the winner")

An LLM or ML model trained on public stats cannot out-predict the closing
line — the market already prices all public information plus sharp money.
What _is_ exploitable:

- **Line shopping / stale lines**: slow retail books lag sharp moves.
- **De-vig + consensus**: beating the _price_, not predicting the game.
- **Discipline**: Kelly sizing and edge thresholds — most bettors lose to
  variance and overbetting long before model quality matters.

Realistic expectations: a good scanner finds 2–5% edges a few times a week.
That is a ~52–54% hit rate on -110 bets — long losing streaks are normal and
guaranteed. Books limit or ban consistent winners.

**Bet only what you can afford to lose. If it stops being fun, stop.**
US problem-gambling helpline: 1-800-GAMBLER.
