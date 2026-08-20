import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { bestDeals, currentBest, shouldDeliver } from './deal.js';
import { formatAlert, formatDealList, formatStatus, HELP_TEXT } from './format.js';
import { buildSearchMatrix } from './matrix.js';
import { rankAlerts, runTick } from './scan.js';
import { createSource, MockSource } from './sources/index.js';
import { loadState, recordAlert, saveState } from './store.js';
import { parseCommand, sleep, TelegramClient, type TelegramUpdate } from './telegram.js';
import type { SearchQuery, Source, TrackerState } from './types.js';

/** Never fire more than this many alerts in one tick — the rest are summarised. */
const MAX_ALERTS_PER_TICK = 6;

function log(message: string): void {
  console.info(`[${new Date().toISOString()}] ${message}`);
}

class Tracker {
  private readonly matrix: SearchQuery[];
  private forceFullSweep = false;
  private stopping = false;

  constructor(
    private readonly cfg: Config,
    private readonly state: TrackerState,
    private readonly source: Source,
    private readonly telegram: TelegramClient | null,
  ) {
    this.matrix = buildSearchMatrix(cfg);
  }

  get matrixSize(): number {
    return this.matrix.length;
  }

  async notify(text: string): Promise<void> {
    if (!this.telegram) {
      log(`(no telegram configured) ${text.replace(/<[^>]+>/g, '')}`);
      return;
    }
    try {
      await this.telegram.sendMessage(text);
    } catch (err) {
      log(`telegram send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async tick(): Promise<void> {
    if (this.state.paused && !this.forceFullSweep) return;

    const full = this.forceFullSweep;
    this.forceFullSweep = false;

    if (this.source instanceof MockSource) this.source.bumpRound();

    const result = await runTick(this.cfg, this.state, this.source, this.matrix, { full });
    log(
      `tick: ${result.queriesRun} queries, ${result.quotesSeen} quotes, ` +
        `${result.alerts.length} alerts, ${result.errors.length} errors` +
        ` (cursor ${this.state.cursor}/${this.matrix.length})`,
    );
    for (const error of result.errors.slice(0, 3)) log(`  error: ${error}`);

    const ranked = rankAlerts(result.alerts);
    const deliverable = ranked.filter((alert) => shouldDeliver(this.cfg, alert));

    for (const alert of deliverable.slice(0, MAX_ALERTS_PER_TICK)) {
      await this.notify(formatAlert(this.cfg, alert));
      recordAlert(this.state, {
        key: `${alert.quote.checkIn}|${alert.quote.nights}|${alert.quote.label.trim().toLowerCase().replace(/\s+/g, ' ')}`,
        reason: alert.reason,
        at: Date.now(),
        total: alert.quote.total,
      });
    }
    if (deliverable.length > MAX_ALERTS_PER_TICK) {
      await this.notify(
        `…and ${deliverable.length - MAX_ALERTS_PER_TICK} more moves this sweep. Send /best to see the cheapest.`,
      );
    }

    if (result.completedBaseline) {
      await this.notify(
        formatDealList(
          bestDeals(this.cfg, this.state, 5),
          '✅ <b>Baseline sweep complete</b> — now watching for drops.\nCheapest so far:',
        ),
      );
    }

    // A run of total failures usually means the site changed or is blocking
    // us; say so once rather than going quiet for weeks.
    if (result.queriesRun > 0 && result.errors.length === result.queriesRun) {
      await this.notify(
        `⚠️ <b>Every query failed this sweep.</b>\n<code>${(result.errors[0] ?? '').slice(0, 300)}</code>`,
      );
    }

    saveState(this.cfg.TRACKER_STATE_FILE, this.state);
  }

  async scanLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (err) {
        log(`tick failed: ${err instanceof Error ? err.stack : String(err)}`);
      }
      const waitMs = this.cfg.TRACKER_POLL_MINUTES * 60_000;
      const step = 2000;
      for (
        let waited = 0;
        waited < waitMs && !this.stopping && !this.forceFullSweep;
        waited += step
      ) {
        await sleep(step);
      }
    }
  }

  async commandLoop(): Promise<void> {
    if (!this.telegram) return;
    while (!this.stopping) {
      try {
        const updates = await this.telegram.getUpdates(this.state.telegramOffset);
        for (const update of updates) {
          this.state.telegramOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
        if (updates.length > 0) saveState(this.cfg.TRACKER_STATE_FILE, this.state);
      } catch (err) {
        log(`getUpdates failed: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(5000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const parsed = parseCommand(update.message?.text);
    if (!parsed) return;
    const chatId = update.message ? String(update.message.chat.id) : undefined;
    const reply = (text: string): Promise<void> =>
      this.telegram
        ? this.telegram.sendMessage(text, chatId).catch(() => undefined)
        : Promise.resolve();

    const amount = Number(parsed.args[0]);
    switch (parsed.command) {
      case 'start':
      case 'help':
        await reply(`${HELP_TEXT}\n\nYour chat id: <code>${chatId ?? 'unknown'}</code>`);
        break;
      case 'best':
        await reply(
          formatDealList(
            bestDeals(this.cfg, this.state, clampLimit(parsed.args[0])),
            '🏆 <b>Cheapest prices ever seen</b>',
          ),
        );
        break;
      case 'now':
        await reply(
          formatDealList(
            currentBest(this.cfg, this.state, clampLimit(parsed.args[0])),
            '🛒 <b>Cheapest currently on sale</b>',
          ),
        );
        break;
      case 'status':
        await reply(formatStatus(this.cfg, this.state, this.matrix.length));
        break;
      case 'scan':
        this.forceFullSweep = true;
        await reply('🔄 Full sweep queued — results in a few minutes.');
        break;
      case 'target':
        if (!Number.isFinite(amount)) {
          await reply('Usage: /target 3200');
          break;
        }
        if (amount <= 0) delete this.state.overrides.targetTotal;
        else this.state.overrides.targetTotal = amount;
        await reply(amount > 0 ? `🎯 Target total set to ${amount}.` : '🎯 Target total cleared.');
        break;
      case 'pppn':
        if (!Number.isFinite(amount)) {
          await reply('Usage: /pppn 55');
          break;
        }
        if (amount <= 0) delete this.state.overrides.targetPppn;
        else this.state.overrides.targetPppn = amount;
        await reply(
          amount > 0 ? `🎯 Target set to ${amount} per person per night.` : '🎯 Target cleared.',
        );
        break;
      case 'drop':
        if (!Number.isFinite(amount) || amount <= 0) {
          await reply('Usage: /drop 5');
          break;
        }
        this.state.overrides.dropPct = amount;
        await reply(`📉 Alerting on drops of ${amount}% or more.`);
        break;
      case 'pause':
        this.state.paused = true;
        await reply('⏸ Scanning paused.');
        break;
      case 'resume':
        this.state.paused = false;
        await reply('▶️ Scanning resumed.');
        break;
      default:
        await reply(`Unknown command. ${HELP_TEXT}`);
    }
    saveState(this.cfg.TRACKER_STATE_FILE, this.state);
  }

  stop(): void {
    this.stopping = true;
  }
}

/**
 * Keeps the mock's price walk moving across restarts. Lives in its own
 * function so the `instanceof` narrowing doesn't leak into `main`, where
 * `source` must stay the plain `Source` interface.
 */
function seedMockSource(source: Source, state: TrackerState): void {
  if (source instanceof MockSource) source.setRound(state.stats.ticks);
}

function clampLimit(arg: string | undefined): number {
  const n = Number(arg);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 5;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const state = loadState(cfg.TRACKER_STATE_FILE);
  const source = createSource(cfg);
  const once = process.argv.includes('--once');

  const telegram = cfg.TELEGRAM_BOT_TOKEN
    ? new TelegramClient(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID)
    : null;
  if (!telegram) {
    log('TELEGRAM_BOT_TOKEN not set — running in console-only mode.');
  }

  await source.init?.();
  seedMockSource(source, state);
  const tracker = new Tracker(cfg, state, source, telegram);
  log(
    `source=${source.name} matrix=${tracker.matrixSize} combos ` +
      `party=${cfg.occupancy.adults}+${cfg.occupancy.childAges.join(',')} ` +
      `season=${cfg.TRACKER_SEASON_START}..${cfg.TRACKER_SEASON_END}`,
  );

  if (once) {
    await tracker.tick();
    await source.close?.();
    return;
  }

  const shutdown = (): void => {
    log('shutting down…');
    tracker.stop();
    saveState(cfg.TRACKER_STATE_FILE, state);
    void source.close?.().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([tracker.scanLoop(), tracker.commandLoop()]);
  await source.close?.();
}

/** True only when this file was run directly, so importing it in tests is safe. */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
