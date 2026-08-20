import { loadConfig, type Config } from '../src/config.js';
import type { Quote } from '../src/types.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    TRACKER_SEASON_START: '2027-06-01',
    TRACKER_SEASON_END: '2027-06-30',
    TRACKER_NIGHTS: '7',
  } as unknown as NodeJS.ProcessEnv);
  return { ...base, ...overrides };
}

export function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    checkIn: '2027-06-12',
    checkOut: '2027-06-19',
    nights: 7,
    label: 'Family room, sea view — Ultra All Inclusive',
    total: 3000,
    currency: 'EUR',
    confidence: 'exact',
    observedAt: Date.now(),
    ...overrides,
  };
}
