import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildSearchMatrix,
  pricePerPersonPerNight,
  quoteKey,
  renderTemplate,
  sliceMatrix,
  weekdayOf,
} from '../src/matrix.js';
import { testConfig } from './helpers.js';

describe('buildSearchMatrix', () => {
  it('covers every check-in date × duration in the season', () => {
    const cfg = testConfig({
      TRACKER_SEASON_START: '2027-06-01',
      TRACKER_SEASON_END: '2027-06-10',
      TRACKER_NIGHTS: [7, 10],
      TRACKER_CHECKIN_STEP_DAYS: 1,
    });
    const matrix = buildSearchMatrix(cfg);
    expect(matrix).toHaveLength(20); // 10 check-in dates × 2 durations
    expect(matrix[0]).toMatchObject({ checkIn: '2027-06-01', checkOut: '2027-06-08', nights: 7 });
    expect(matrix.at(-1)).toMatchObject({
      checkIn: '2027-06-10',
      checkOut: '2027-06-20',
      nights: 10,
    });
  });

  it('honours a weekday filter', () => {
    const cfg = testConfig({
      TRACKER_SEASON_START: '2027-06-01',
      TRACKER_SEASON_END: '2027-06-30',
      TRACKER_NIGHTS: [7],
      TRACKER_CHECKIN_WEEKDAYS: [6], // Saturdays only
    });
    const matrix = buildSearchMatrix(cfg);
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix.every((q) => weekdayOf(q.checkIn) === 6)).toBe(true);
  });

  it('carries the configured party into every query', () => {
    const cfg = testConfig();
    const [first] = buildSearchMatrix(cfg);
    expect(first?.occupancy).toEqual({ adults: 3, childAges: [12] });
  });

  it('rejects an inverted season window', () => {
    const cfg = testConfig({
      TRACKER_SEASON_START: '2027-09-01',
      TRACKER_SEASON_END: '2027-06-01',
    });
    expect(() => buildSearchMatrix(cfg)).toThrow(/must be after/);
  });
});

describe('sliceMatrix', () => {
  const items = [1, 2, 3, 4, 5];

  it('wraps around the end so the sweep is continuous', () => {
    expect(sliceMatrix(items, 3, 4)).toEqual([4, 5, 1, 2]);
  });

  it('never returns more items than exist', () => {
    expect(sliceMatrix(items, 0, 99)).toHaveLength(5);
    expect(sliceMatrix([], 0, 3)).toEqual([]);
  });
});

describe('helpers', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2027-06-28', 7)).toBe('2027-07-05');
  });

  it('normalises labels into a stable history key', () => {
    const a = quoteKey({ checkIn: '2027-06-12', nights: 7, label: 'Family  Room ' });
    const b = quoteKey({ checkIn: '2027-06-12', nights: 7, label: 'family room' });
    expect(a).toBe(b);
  });

  it('divides a total across the whole party and stay', () => {
    expect(pricePerPersonPerNight(2800, 7, 4)).toBe(100);
  });

  it('fills booking-link placeholders', () => {
    const url = renderTemplate(
      'https://x/?in={checkIn}&out={checkOut}&a={adults}&ages={childAges}',
      {
        checkIn: '2027-06-12',
        checkOut: '2027-06-19',
        nights: 7,
        occupancy: { adults: 3, childAges: [12] },
        currency: 'EUR',
      },
    );
    expect(url).toBe('https://x/?in=2027-06-12&out=2027-06-19&a=3&ages=12');
  });

  it('leaves unknown placeholders alone so typos are visible', () => {
    expect(
      renderTemplate('{nope}', {
        checkIn: '2027-06-12',
        checkOut: '2027-06-19',
        nights: 7,
        occupancy: { adults: 3, childAges: [12] },
        currency: 'EUR',
      }),
    ).toBe('{nope}');
  });
});
