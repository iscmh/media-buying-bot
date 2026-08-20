# Reina del Mar deal tracker

A Telegram bot that watches the HVD Reina del Mar booking engine (Obzor,
Bulgaria) for **3 adults + 1 child aged 12**, sweeps every check-in date and
stay length across next season, and messages you when a price drops, hits a
new low, or reaches a target you set.

It lives in this repo but is standalone — no Supabase, no Meta credentials,
nothing shared with the media-buying app. It runs off a single JSON state file
and can sit on a laptop, a Pi, or the cheapest VPS you can find.

```
                         every TRACKER_POLL_MINUTES
                                    │
   season matrix  ──►  slice of N   ▼   ──►  source  ──►  quotes
   (dates × nights)     (rolling cursor)   (api/browser)     │
                                                             ▼
                                          price history + all-time lows
                                                             │
                                       drop? new low? target hit?  ──► Telegram
```

---

## Read this first

The hotel's engine (`reservations.hvdhotels.com`) is a JavaScript app that
fetches prices over its own private JSON API. That API is not public and its
exact shape could not be inspected while this was written — the build
environment has no outbound internet access. So the site-specific part is
**deliberately data-driven, not hard-coded**, and there is a recorder that
fills it in for you in about two minutes (`pnpm discover`, below).

Until you run that, the tracker still works: `TRACKER_SOURCE=browser` drives
the real widget in a headless browser and finds prices by shape rather than by
selector. It is just slower and less precise than replaying the JSON call.

---

## Quick start

```bash
cd apps/deal-tracker
pnpm install
cp .env.example .env

# 1. Prove the whole pipeline works, with no network calls at all.
pnpm scan            # TRACKER_SOURCE=mock by default — prints a fake sweep

# 2. Hook up Telegram: @BotFather -> /newbot -> paste the token into .env,
#    then message your bot /start — it replies with your chat id.
pnpm start
```

Once alerts are landing in your chat, point it at the real site.

---

## Wiring up the real site

### Option A — replay the engine's JSON call (fast, recommended)

```bash
pnpm discover        # opens a real browser window
```

Do the search by hand: your dates, 3 adults, 1 child aged 12. Wait for prices
to appear, then press Enter in the terminal. The recorder writes every JSON
response the page fetched to `data/discovery-<timestamp>.json`, ranks them by
how price-shaped they are, and drops a ready-made template at
`data/endpoint.suggested.json`:

```jsonc
{
  "url": "https://reservations.hvdhotels.com/api/....?arrival=2027-06-12&nights=7",
  "method": "GET",
  "headers": { "accept": "application/json", "cookie": "..." },
  "offersPath": "offers[*]", // where the list of rooms lives
  "pricePath": "price.total", // the stay total, inside each room
  "labelPath": "roomType.name", // what to call it in the alert
}
```

Two edits and you are done:

1. Replace your literal dates/occupancy with placeholders —
   `{checkIn}` `{checkOut}` `{nights}` `{adults}` `{children}` `{childAges}` `{currency}`.
2. Sanity-check `pricePath` points at the **stay total**, not a per-night rate.

```bash
cp data/endpoint.suggested.json data/endpoint.json
TRACKER_SOURCE=api pnpm scan     # one sweep, prints what it found
```

If a response ever stops parsing, the last bad body is written to
`data/last-failure.txt` so you can see what changed.

### Option B — drive the browser (works immediately, no reverse-engineering)

```bash
TRACKER_SOURCE=browser pnpm scan
```

With no configuration it loads the booking page and takes the cheapest
plausible number on it, flagged in alerts as heuristic. To make it exact,
create `data/selectors.json` from what you see in devtools:

```json
{
  "acceptCookies": "#onetrust-accept-btn-handler",
  "card": "[data-testid='room-offer']",
  "label": ".room-title",
  "price": ".total-price",
  "link": "a.book-now"
}
```

Set `TRACKER_URL_TEMPLATE` too if the engine accepts search params in the URL —
without it every query lands on the same default page. Run with
`TRACKER_HEADLESS=false` while you work the selectors out.

---

## How the sweep is paced

The default season (1 Jun – 15 Sep, 7/10/14 nights, daily check-ins) is **321
combinations**. Re-pricing all of those every few minutes would be both
pointless and rude — hotel prices move on the order of hours, not seconds.

So each tick prices a slice (`TRACKER_QUERIES_PER_TICK`, default 24) and a
rolling cursor advances through the matrix. At the defaults that is a complete
re-price of next season roughly **every 70 minutes**, with two concurrent
requests about a second apart — gentler than a person clicking around the site,
and it still catches a flash drop the same afternoon it appears.

Want it tighter? Narrow the search rather than raising the rate:

```bash
TRACKER_CHECKIN_WEEKDAYS=5,6     # only Fri/Sat arrivals
TRACKER_NIGHTS=7                 # one duration
TRACKER_SEASON_START=2027-07-01
TRACKER_SEASON_END=2027-08-31
```

That is 18 combinations — a full sweep every tick.

---

## What counts as "a good offer"

Every quote is filed under `(check-in, nights, room)` and kept as a price
history. An alert fires when:

| Reason             | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| 🎯 `target_hit`    | At or below `/target` (total) or `/pppn` (per person per night) |
| 📉 `new_low`       | Cheapest this exact stay has _ever_ been since tracking started |
| 💸 `price_drop`    | Down at least `TRACKER_DROP_PCT` since the last sweep           |
| 🔓 `back_in_stock` | Sold out for 2+ days, now bookable again                        |

Guard rails, because a scraper that cries wolf gets muted and then misses the
one alert that mattered:

- **No alerts during the first full sweep** — everything looks like news when
  you have no history. You get one "baseline complete" summary instead. The
  exception is a target hit, which fires immediately.
- **Cooldown** per offer per reason (`TRACKER_ALERT_COOLDOWN_HOURS`), so a
  price wobbling around a threshold doesn't spam you.
- **Sanity band** — a "price" below `TRACKER_MIN_PLAUSIBLE_TOTAL` or above
  `TRACKER_MAX_PLAUSIBLE_TOTAL` is treated as a scraping mistake and dropped.
  This is what stops a per-night rate being alerted as a stay total.
- **Quiet hours** hold routine alerts overnight. Target hits ignore them.
- Ranking is by **price per person per night**, so a cheap 14-night stay is
  compared fairly against a 7-night one.

---

## Telegram commands

| Command            | Does                                                  |
| ------------------ | ----------------------------------------------------- |
| `/best`            | Cheapest prices ever recorded                         |
| `/now`             | Cheapest currently on sale                            |
| `/status`          | Source, matrix size, sweep progress, error count      |
| `/scan`            | Force a full sweep right now                          |
| `/target 3200`     | Alert at/below this total (`0` clears)                |
| `/pppn 55`         | Alert at/below this per person per night (`0` clears) |
| `/drop 5`          | Alert on drops of ≥5%                                 |
| `/pause` `/resume` | Stop/restart scanning                                 |

---

## Running it for months

```bash
# systemd
sudo tee /etc/systemd/system/deal-tracker.service >/dev/null <<'UNIT'
[Unit]
Description=Reina del Mar deal tracker
After=network-online.target

[Service]
WorkingDirectory=/home/you/media-buying-bot/apps/deal-tracker
EnvironmentFile=/home/you/media-buying-bot/apps/deal-tracker/.env
ExecStart=/usr/bin/env pnpm start
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now deal-tracker
```

State lives in `data/state.json` and is written atomically after every tick, so
a restart resumes with its full price history. `data/quotes.ndjson` is an
append-only log of every quote seen — useful if you later want to plot the
curve and argue with yourself about whether to book now.

If every query in a sweep fails, the bot says so once in the chat. That is
usually the engine changing its API (re-run `pnpm discover`) or rate-limiting
you (raise `TRACKER_REQUEST_DELAY_MS`).

---

## Caveats worth knowing before you rely on it

- **Direct-booking prices are not the only prices.** Package operators
  (Jet2, loveholidays, easyJet holidays, TUI) often undercut the hotel's own
  engine for a family of four, flights included. This tracker watches the
  hotel direct. Adding an operator is a new file in `src/sources/` that
  implements `Source` — the rest of the pipeline doesn't care where quotes
  come from.
- **A tracked price is not a held price.** It tells you when to go and book;
  it does not book anything. Nothing here submits a reservation.
- **Be polite.** The defaults are deliberately gentle. Turning the concurrency
  up and the delay down is the fastest way to get your IP blocked and learn
  nothing about Bulgarian hotel prices.

---

## Development

```bash
pnpm test        # 69 unit tests, no network
pnpm typecheck
pnpm lint
```

| File              | Role                                                    |
| ----------------- | ------------------------------------------------------- |
| `src/config.ts`   | Env parsing and the search/alert knobs                  |
| `src/matrix.ts`   | Builds the (date × nights) search space, rolling cursor |
| `src/sources/`    | `api` / `browser` / `mock` price adapters               |
| `src/extract.ts`  | Money parsing and the price-finding heuristics          |
| `src/deal.ts`     | What counts as an alert, and ranking                    |
| `src/scan.ts`     | One tick: fetch a slice, fold into history              |
| `src/telegram.ts` | Bot API client and command parsing                      |
| `src/discover.ts` | The one-off recorder that pins down the real endpoint   |
