import { describe, expect, it } from 'vitest';
import {
  coerceNumber,
  findPriceCandidates,
  parseMoney,
  parseMoneyAll,
  queryPath,
  type Json,
} from '../src/extract.js';

describe('parseMoney', () => {
  it('handles the separator conventions the engine might use', () => {
    expect(parseMoney('€1,234.56')).toEqual({ value: 1234.56, currency: 'EUR' });
    expect(parseMoney('1.234,56 €')).toEqual({ value: 1234.56, currency: 'EUR' });
    expect(parseMoney('1 234,00 лв.')).toEqual({ value: 1234, currency: 'BGN' });
    expect(parseMoney('2450 EUR')).toEqual({ value: 2450, currency: 'EUR' });
    expect(parseMoney('3199')).toEqual({ value: 3199 });
  });

  it('reads a lone three-digit group as thousands, not decimals', () => {
    expect(parseMoney('1.234')?.value).toBe(1234);
    expect(parseMoney('1,234')?.value).toBe(1234);
    // Two decimals is unambiguous.
    expect(parseMoney('1.23')?.value).toBe(1.23);
  });

  it('returns null when there is no number', () => {
    expect(parseMoney('sold out')).toBeNull();
  });

  it('finds every price in a block of card text', () => {
    const values = parseMoneyAll('was €3,400\nnow €2,980\n€49 per night').map((m) => m.value);
    expect(values).toEqual([3400, 2980, 49]);
  });
});

describe('findPriceCandidates', () => {
  const payload: Json = {
    offers: [
      {
        roomType: { name: 'Family sea view' },
        price: { total: 2980.5, perNight: 425.8, nightlyRate: 425.8, currency: 'EUR' },
        taxes: { total: 120 },
      },
      {
        roomType: { name: 'Standard park view' },
        price: { total: 2410, perNight: 344, currency: 'EUR' },
      },
    ],
    resultCount: 2,
  };

  it('ranks stay totals above per-night and tax figures', () => {
    const [top] = findPriceCandidates(payload);
    // Equal-scoring candidates are ordered cheapest-first, which is what the
    // heuristic source wants to quote.
    expect(top?.path).toBe('offers[1].price.total');
    expect(top?.currency).toBe('EUR');

    const paths = findPriceCandidates(payload).map((c) => c.path);
    expect(paths.indexOf('offers[0].price.total')).toBeLessThan(
      paths.indexOf('offers[0].price.nightlyRate'),
    );
    expect(paths.indexOf('offers[0].price.total')).toBeLessThan(
      paths.indexOf('offers[0].taxes.total'),
    );
  });

  it('ignores fields that are not price-shaped at all', () => {
    const paths = findPriceCandidates(payload).map((c) => c.path);
    // A counter that happens to contain a keyword, and a per-night figure
    // whose key says nothing about money.
    expect(paths).not.toContain('resultCount');
    expect(paths).not.toContain('offers[0].price.perNight');
  });
});

describe('queryPath', () => {
  const payload: Json = { data: { offers: [{ p: 1 }, { p: 2 }, { p: 3 }] } };

  it('fans out over arrays with [*]', () => {
    expect(queryPath(payload, 'data.offers[*].p')).toEqual([1, 2, 3]);
  });

  it('indexes directly', () => {
    expect(queryPath(payload, 'data.offers[1].p')).toEqual([2]);
  });

  it('returns nothing for a path that does not exist', () => {
    expect(queryPath(payload, 'data.nope[*].p')).toEqual([]);
  });
});

describe('coerceNumber', () => {
  it('accepts numbers and money strings alike', () => {
    expect(coerceNumber(2980)).toBe(2980);
    expect(coerceNumber('2 980,00 €')).toBe(2980);
    expect(coerceNumber(null)).toBeNull();
  });
});
