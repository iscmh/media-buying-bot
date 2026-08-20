import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSearchMatrix } from '../src/matrix.js';
import { rankAlerts, runTick } from '../src/scan.js';
import { MockSource } from '../src/sources/mock.js';
import { emptyState, loadState, saveState } from '../src/store.js';
import type { Quote, SearchQuery, Source } from '../src/types.js';
import { quote, testConfig } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deal-tracker-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfgIn(overrides = {}) {
  return testConfig({
    TRACKER_SEASON_START: '2027-06-01',
    TRACKER_SEASON_END: '2027-06-06',
    TRACKER_NIGHTS: [7],
    TRACKER_REQUEST_DELAY_MS: 0,
    TRACKER_STATE_FILE: join(dir, 'state.json'),
    TRACKER_LOG_FILE: join(dir, 'quotes.ndjson'),
    ...overrides,
  });
}

describe('runTick', () => {
  it('walks the matrix a slice at a time and flips the baseline when it wraps', async () => {
    const cfg = cfgIn({ TRACKER_QUERIES_PER_TICK: 3 });
    const state = emptyState();
    const source = new MockSource(cfg);
    const matrix = buildSearchMatrix(cfg);
    expect(matrix).toHaveLength(6);

    const first = await runTick(cfg, state, source, matrix);
    expect(first.queriesRun).toBe(3);
    expect(state.cursor).toBe(3);
    expect(state.baselineComplete).toBe(false);
    expect(first.alerts).toHaveLength(0); // silent while building the baseline

    const second = await runTick(cfg, state, source, matrix);
    expect(second.completedBaseline).toBe(true);
    expect(state.baselineComplete).toBe(true);
    expect(state.cursor).toBe(0);
    expect(Object.keys(state.prices).length).toBe(18); // 6 combos × 3 room types
  });

  it('alerts once prices move after the baseline', async () => {
    const cfg = cfgIn({ TRACKER_QUERIES_PER_TICK: 6, TRACKER_DROP_PCT: 1 });
    const state = emptyState();
    const source = new MockSource(cfg);
    const matrix = buildSearchMatrix(cfg);

    await runTick(cfg, state, source, matrix);
    expect(state.baselineComplete).toBe(true);

    source.bumpRound(); // prices wander
    const second = await runTick(cfg, state, source, matrix);
    expect(second.alerts.length).toBeGreaterThan(0);
    expect(second.alerts.every((a) => a.quote.total > 0)).toBe(true);
  });

  it('survives a source that throws and records the error', async () => {
    const cfg = cfgIn({ TRACKER_QUERIES_PER_TICK: 2 });
    const state = emptyState();
    const broken: Source = {
      name: 'broken',
      fetchQuotes: async () => {
        throw new Error('HTTP 503 from booking API');
      },
    };
    const result = await runTick(cfg, state, broken, buildSearchMatrix(cfg));
    expect(result.errors).toHaveLength(2);
    expect(result.alerts).toHaveLength(0);
    expect(state.stats.lastError).toContain('503');
  });

  it('discards implausible quotes instead of recording them', async () => {
    const cfg = cfgIn({ TRACKER_QUERIES_PER_TICK: 1, TRACKER_MIN_PLAUSIBLE_TOTAL: 150 });
    const state = emptyState();
    const junk: Source = {
      name: 'junk',
      fetchQuotes: async (query: SearchQuery): Promise<Quote[]> => [
        quote({ checkIn: query.checkIn, total: 49, label: 'per-night figure' }),
        quote({ checkIn: query.checkIn, total: 2800, label: 'real total' }),
      ],
    };
    await runTick(cfg, state, junk, buildSearchMatrix(cfg));
    const labels = Object.values(state.prices).map((p) => p.label);
    expect(labels).toEqual(['real total']);
  });
});

describe('rankAlerts', () => {
  it('puts target hits first, then cheapest per person per night', () => {
    const ranked = rankAlerts([
      { reason: 'price_drop', quote: quote(), pppn: 80 },
      { reason: 'target_hit', quote: quote(), pppn: 120 },
      { reason: 'new_low', quote: quote(), pppn: 95 },
      { reason: 'new_low', quote: quote(), pppn: 60 },
    ]);
    expect(ranked.map((a) => [a.reason, a.pppn])).toEqual([
      ['target_hit', 120],
      ['new_low', 60],
      ['new_low', 95],
      ['price_drop', 80],
    ]);
  });
});

describe('state persistence', () => {
  it('round-trips through disk', () => {
    const file = join(dir, 'state.json');
    const state = emptyState();
    state.cursor = 12;
    state.overrides.targetTotal = 3200;
    saveState(file, state);
    expect(loadState(file)).toMatchObject({ cursor: 12, overrides: { targetTotal: 3200 } });
  });

  it('starts clean rather than crashing on a corrupt file', () => {
    const file = join(dir, 'broken.json');
    saveState(file, emptyState());
    // Simulate a half-written file from a hard kill.
    writeFileSync(file, '{"version":1,"prices":', 'utf8');
    expect(loadState(file).cursor).toBe(0);
  });
});
